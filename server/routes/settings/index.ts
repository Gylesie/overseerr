import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import { merge, omit, set, sortBy } from 'lodash';
import { rescheduleJob } from 'node-schedule';
import path from 'path';
import semver from 'semver';
import { getRepository } from 'typeorm';
import { URL } from 'url';
import PlexAPI from '../../api/plexapi';
import PlexTvAPI from '../../api/plextv';
import TautulliAPI from '../../api/tautulli';
import Media from '../../entity/Media';
import { MediaRequest } from '../../entity/MediaRequest';
import { User } from '../../entity/User';
import type { PlexConnection } from '../../interfaces/api/plexInterfaces';
import type {
  LogMessage,
  LogsResultsResponse,
  SettingsAboutResponse,
} from '../../interfaces/api/settingsInterfaces';
import { scheduledJobs } from '../../job/schedule';
import type { AvailableCacheIds } from '../../lib/cache';
import cacheManager from '../../lib/cache';
import { Permission } from '../../lib/permissions';
import { plexFullScanner } from '../../lib/scanners/plex';
import type { MainSettings } from '../../lib/settings';
import { getSettings } from '../../lib/settings';
import logger from '../../logger';
import { isAuthenticated } from '../../middleware/auth';
import { appDataPath } from '../../utils/appDataVolume';
import { getAppVersion } from '../../utils/appVersion';
import restartFlag from '../../utils/restartFlag';
import notificationRoutes from './notifications';
import radarrRoutes from './radarr';
import sonarrRoutes from './sonarr';

const settingsRoutes = Router();

settingsRoutes.use('/notifications', notificationRoutes);
settingsRoutes.use('/radarr', radarrRoutes);
settingsRoutes.use('/sonarr', sonarrRoutes);

const filteredMainSettings = (
  user: User,
  main: MainSettings
): Partial<MainSettings> => {
  if (!user?.hasPermission(Permission.ADMIN)) {
    return omit(main, 'apiKey');
  }

  return main;
};

settingsRoutes.get('/main', (req, res, next) => {
  const settings = getSettings();

  if (!req.user) {
    return next({ status: 400, message: 'User missing from request.' });
  }

  res.status(200).json(filteredMainSettings(req.user, settings.main));
});

settingsRoutes.post('/main', (req, res) => {
  const settings = getSettings();

  if (
    settings.main.csrfProtection !== req.body.csrfProtection ||
    settings.main.trustProxy !== req.body.trustProxy
  ) {
    restartFlag.set();
  }

  settings.main = merge(settings.main, req.body);
  settings.save();

  return res.status(200).json(settings.main);
});

settingsRoutes.post('/main/regenerate', (req, res, next) => {
  const settings = getSettings();

  const main = settings.regenerateApiKey();

  if (!req.user) {
    return next({ status: 500, message: 'User missing from request.' });
  }

  return res.status(200).json(filteredMainSettings(req.user, main));
});

settingsRoutes.get('/plex', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.plex);
});

settingsRoutes.post('/plex', async (req, res, next) => {
  const userRepository = getRepository(User);
  const settings = getSettings();
  try {
    const admin = await userRepository.findOneOrFail({
      select: ['id', 'plexToken'],
      order: { id: 'ASC' },
    });

    Object.assign(settings.plex, req.body);

    const plexClient = new PlexAPI({ plexToken: admin.plexToken });

    const result = await plexClient.getStatus();

    if (!result?.MediaContainer?.machineIdentifier) {
      throw new Error('Server not found');
    }

    settings.plex.machineId = result.MediaContainer.machineIdentifier;
    settings.plex.name = result.MediaContainer.friendlyName;

    settings.save();
  } catch (e) {
    logger.error('Something went wrong testing Plex connection', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to connect to Plex.',
    });
  }

  return res.status(200).json(settings.plex);
});

settingsRoutes.get('/plex/devices/servers', async (req, res, next) => {
  const userRepository = getRepository(User);
  try {
    const admin = await userRepository.findOneOrFail({
      select: ['id', 'plexToken'],
      order: { id: 'ASC' },
    });
    const plexTvClient = admin.plexToken
      ? new PlexTvAPI(admin.plexToken)
      : null;
    const devices = (await plexTvClient?.getDevices())?.filter((device) => {
      return device.provides.includes('server') && device.owned;
    });
    const settings = getSettings();

    if (devices) {
      await Promise.all(
        devices.map(async (device) => {
          const plexDirectConnections: PlexConnection[] = [];

          device.connection.forEach((connection) => {
            const url = new URL(connection.uri);

            if (url.hostname !== connection.address) {
              const plexDirectConnection = { ...connection };
              plexDirectConnection.address = url.hostname;
              plexDirectConnections.push(plexDirectConnection);

              // Connect to IP addresses over HTTP
              connection.protocol = 'http';
            }
          });

          plexDirectConnections.forEach((plexDirectConnection) => {
            device.connection.push(plexDirectConnection);
          });

          await Promise.all(
            device.connection.map(async (connection) => {
              const plexDeviceSettings = {
                ...settings.plex,
                ip: connection.address,
                port: connection.port,
                useSsl: connection.protocol === 'https',
              };
              const plexClient = new PlexAPI({
                plexToken: admin.plexToken,
                plexSettings: plexDeviceSettings,
                timeout: 5000,
              });

              try {
                await plexClient.getStatus();
                connection.status = 200;
                connection.message = 'OK';
              } catch (e) {
                connection.status = 500;
                connection.message = e.message.split(':')[0];
              }
            })
          );
        })
      );
    }
    return res.status(200).json(devices);
  } catch (e) {
    logger.error('Something went wrong retrieving Plex server list', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve Plex server list.',
    });
  }
});

settingsRoutes.get('/plex/library', async (req, res) => {
  const settings = getSettings();

  if (req.query.sync) {
    const userRepository = getRepository(User);
    const admin = await userRepository.findOneOrFail({
      select: ['id', 'plexToken'],
      order: { id: 'ASC' },
    });
    const plexapi = new PlexAPI({ plexToken: admin.plexToken });

    await plexapi.syncLibraries();
  }

  const enabledLibraries = req.query.enable
    ? (req.query.enable as string).split(',')
    : [];
  settings.plex.libraries = settings.plex.libraries.map((library) => ({
    ...library,
    enabled: enabledLibraries.includes(library.id),
  }));
  settings.save();
  return res.status(200).json(settings.plex.libraries);
});

settingsRoutes.get('/plex/sync', (_req, res) => {
  return res.status(200).json(plexFullScanner.status());
});

settingsRoutes.post('/plex/sync', (req, res) => {
  if (req.body.cancel) {
    plexFullScanner.cancel();
  } else if (req.body.start) {
    plexFullScanner.run();
  }
  return res.status(200).json(plexFullScanner.status());
});

settingsRoutes.get('/tautulli', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.tautulli);
});

settingsRoutes.post('/tautulli', async (req, res, next) => {
  const settings = getSettings();

  Object.assign(settings.tautulli, req.body);

  try {
    const tautulliClient = new TautulliAPI(settings.tautulli);

    const result = await tautulliClient.getInfo();

    if (!semver.gte(semver.coerce(result?.tautulli_version) ?? '', '2.9.0')) {
      throw new Error('Tautulli version not supported');
    }

    settings.save();
  } catch (e) {
    logger.error('Something went wrong testing Tautulli connection', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to connect to Tautulli.',
    });
  }

  return res.status(200).json(settings.tautulli);
});

settingsRoutes.get(
  '/plex/users',
  isAuthenticated(Permission.MANAGE_USERS),
  async (req, res, next) => {
    const userRepository = getRepository(User);
    const qb = userRepository.createQueryBuilder('user');

    try {
      const admin = await userRepository.findOneOrFail({
        select: ['id', 'plexToken'],
        order: { id: 'ASC' },
      });
      const plexApi = new PlexTvAPI(admin.plexToken ?? '');
      const plexUsers = (await plexApi.getUsers()).MediaContainer.User.map(
        (user) => user.$
      ).filter((user) => user.email);

      const unimportedPlexUsers: {
        id: string;
        title: string;
        username: string;
        email: string;
        thumb: string;
      }[] = [];

      const existingUsers = await qb
        .where('user.plexId IN (:...plexIds)', {
          plexIds: plexUsers.map((plexUser) => plexUser.id),
        })
        .orWhere('user.email IN (:...plexEmails)', {
          plexEmails: plexUsers.map((plexUser) => plexUser.email.toLowerCase()),
        })
        .getMany();

      await Promise.all(
        plexUsers.map(async (plexUser) => {
          if (
            !existingUsers.find(
              (user) =>
                user.plexId === parseInt(plexUser.id) ||
                user.email === plexUser.email.toLowerCase()
            ) &&
            (await plexApi.checkUserAccess(parseInt(plexUser.id)))
          ) {
            unimportedPlexUsers.push(plexUser);
          }
        })
      );

      return res.status(200).json(sortBy(unimportedPlexUsers, 'username'));
    } catch (e) {
      logger.error('Something went wrong getting unimported Plex users', {
        label: 'API',
        errorMessage: e.message,
      });
      next({
        status: 500,
        message: 'Unable to retrieve unimported Plex users.',
      });
    }
  }
);

settingsRoutes.get(
  '/logs',
  rateLimit({ windowMs: 60 * 1000, max: 50 }),
  (req, res, next) => {
    const pageSize = req.query.take ? Number(req.query.take) : 25;
    const skip = req.query.skip ? Number(req.query.skip) : 0;

    let filter: string[] = [];
    switch (req.query.filter) {
      case 'debug':
        filter.push('debug');
      // falls through
      case 'info':
        filter.push('info');
      // falls through
      case 'warn':
        filter.push('warn');
      // falls through
      case 'error':
        filter.push('error');
        break;
      default:
        filter = ['debug', 'info', 'warn', 'error'];
    }

    const logFile = process.env.CONFIG_DIRECTORY
      ? `${process.env.CONFIG_DIRECTORY}/logs/.machinelogs.json`
      : path.join(__dirname, '../../../config/logs/.machinelogs.json');
    const logs: LogMessage[] = [];
    const logMessageProperties = [
      'timestamp',
      'level',
      'label',
      'message',
      'data',
    ];

    try {
      fs.readFileSync(logFile, 'utf-8')
        .split('\n')
        .forEach((line) => {
          if (!line.length) return;

          const logMessage = JSON.parse(line);

          if (!filter.includes(logMessage.level)) {
            return;
          }

          if (
            !Object.keys(logMessage).every((key) =>
              logMessageProperties.includes(key)
            )
          ) {
            Object.keys(logMessage)
              .filter((prop) => !logMessageProperties.includes(prop))
              .forEach((prop) => {
                set(logMessage, `data.${prop}`, logMessage[prop]);
              });
          }

          logs.push(logMessage);
        });

      const displayedLogs = logs.reverse().slice(skip, skip + pageSize);

      return res.status(200).json({
        pageInfo: {
          pages: Math.ceil(logs.length / pageSize),
          pageSize,
          results: logs.length,
          page: Math.ceil(skip / pageSize) + 1,
        },
        results: displayedLogs,
      } as LogsResultsResponse);
    } catch (error) {
      logger.error('Something went wrong while retrieving logs', {
        label: 'Logs',
        errorMessage: error.message,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve logs.',
      });
    }
  }
);

settingsRoutes.get('/jobs', (_req, res) => {
  return res.status(200).json(
    scheduledJobs.map((job) => ({
      id: job.id,
      name: job.name,
      type: job.type,
      interval: job.interval,
      nextExecutionTime: job.job.nextInvocation(),
      running: job.running ? job.running() : false,
    }))
  );
});

settingsRoutes.post<{ jobId: string }>('/jobs/:jobId/run', (req, res, next) => {
  const scheduledJob = scheduledJobs.find((job) => job.id === req.params.jobId);

  if (!scheduledJob) {
    return next({ status: 404, message: 'Job not found.' });
  }

  scheduledJob.job.invoke();

  return res.status(200).json({
    id: scheduledJob.id,
    name: scheduledJob.name,
    type: scheduledJob.type,
    interval: scheduledJob.interval,
    nextExecutionTime: scheduledJob.job.nextInvocation(),
    running: scheduledJob.running ? scheduledJob.running() : false,
  });
});

settingsRoutes.post<{ jobId: string }>(
  '/jobs/:jobId/cancel',
  (req, res, next) => {
    const scheduledJob = scheduledJobs.find(
      (job) => job.id === req.params.jobId
    );

    if (!scheduledJob) {
      return next({ status: 404, message: 'Job not found.' });
    }

    if (scheduledJob.cancelFn) {
      scheduledJob.cancelFn();
    }

    return res.status(200).json({
      id: scheduledJob.id,
      name: scheduledJob.name,
      type: scheduledJob.type,
      interval: scheduledJob.interval,
      nextExecutionTime: scheduledJob.job.nextInvocation(),
      running: scheduledJob.running ? scheduledJob.running() : false,
    });
  }
);

settingsRoutes.post<{ jobId: string }>(
  '/jobs/:jobId/schedule',
  (req, res, next) => {
    const scheduledJob = scheduledJobs.find(
      (job) => job.id === req.params.jobId
    );

    if (!scheduledJob) {
      return next({ status: 404, message: 'Job not found.' });
    }

    const result = rescheduleJob(scheduledJob.job, req.body.schedule);
    const settings = getSettings();

    if (result) {
      settings.jobs[scheduledJob.id].schedule = req.body.schedule;
      settings.save();

      return res.status(200).json({
        id: scheduledJob.id,
        name: scheduledJob.name,
        type: scheduledJob.type,
        interval: scheduledJob.interval,
        nextExecutionTime: scheduledJob.job.nextInvocation(),
        running: scheduledJob.running ? scheduledJob.running() : false,
      });
    } else {
      return next({ status: 400, message: 'Invalid job schedule.' });
    }
  }
);

settingsRoutes.get('/cache', (req, res) => {
  const caches = cacheManager.getAllCaches();

  return res.status(200).json(
    Object.values(caches).map((cache) => ({
      id: cache.id,
      name: cache.name,
      stats: cache.getStats(),
    }))
  );
});

settingsRoutes.post<{ cacheId: AvailableCacheIds }>(
  '/cache/:cacheId/flush',
  (req, res, next) => {
    const cache = cacheManager.getCache(req.params.cacheId);

    if (cache) {
      cache.flush();
      return res.status(204).send();
    }

    next({ status: 404, message: 'Cache not found.' });
  }
);

settingsRoutes.post(
  '/initialize',
  isAuthenticated(Permission.ADMIN),
  (_req, res) => {
    const settings = getSettings();

    settings.public.initialized = true;
    settings.save();

    return res.status(200).json(settings.public);
  }
);

settingsRoutes.get('/about', async (req, res) => {
  const mediaRepository = getRepository(Media);
  const mediaRequestRepository = getRepository(MediaRequest);

  const totalMediaItems = await mediaRepository.count();
  const totalRequests = await mediaRequestRepository.count();

  return res.status(200).json({
    version: getAppVersion(),
    totalMediaItems,
    totalRequests,
    tz: process.env.TZ,
    appDataPath: appDataPath(),
  } as SettingsAboutResponse);
});

export default settingsRoutes;
