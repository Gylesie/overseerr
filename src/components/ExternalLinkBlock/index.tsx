import React from 'react';
import { MediaType } from '../../../server/constants/media';
import ImdbLogo from '../../assets/services/imdb.svg';
import PlexLogo from '../../assets/services/plex.svg';
import RTLogo from '../../assets/services/rt.svg';
import TmdbLogo from '../../assets/services/tmdb.svg';
import TraktLogo from '../../assets/services/trakt.svg';
import TvdbLogo from '../../assets/services/tvdb.svg';
import useLocale from '../../hooks/useLocale';

interface ExternalLinkBlockProps {
  mediaType: 'movie' | 'tv';
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
  rtUrl?: string;
  plexUrl?: string;
}

const ExternalLinkBlock: React.FC<ExternalLinkBlockProps> = ({
  mediaType,
  tmdbId,
  tvdbId,
  imdbId,
  rtUrl,
  plexUrl,
}) => {
  const { locale } = useLocale();

  return (
    <div className="flex w-full items-center justify-center space-x-5">
      {plexUrl && (
        <a
          href={plexUrl}
          className="w-12 opacity-50 transition duration-300 hover:opacity-100"
          target="_blank"
          rel="noreferrer"
        >
          <PlexLogo />
        </a>
      )}
      {tmdbId && (
        <a
          href={`https://www.themoviedb.org/${mediaType}/${tmdbId}?language=${locale}`}
          className="w-8 opacity-50 transition duration-300 hover:opacity-100"
          target="_blank"
          rel="noreferrer"
        >
          <TmdbLogo />
        </a>
      )}
      {tvdbId && mediaType === MediaType.TV && (
        <a
          href={`http://www.thetvdb.com/?tab=series&id=${tvdbId}`}
          className="w-9 opacity-50 transition duration-300 hover:opacity-100"
          target="_blank"
          rel="noreferrer"
        >
          <TvdbLogo />
        </a>
      )}
      {imdbId && (
        <a
          href={`https://www.imdb.com/title/${imdbId}`}
          className="w-8 opacity-50 transition duration-300 hover:opacity-100"
          target="_blank"
          rel="noreferrer"
        >
          <ImdbLogo />
        </a>
      )}
      {rtUrl && (
        <a
          href={`${rtUrl}`}
          className="w-14 opacity-50 transition duration-300 hover:opacity-100"
          target="_blank"
          rel="noreferrer"
        >
          <RTLogo />
        </a>
      )}
      {tmdbId && (
        <a
          href={`https://trakt.tv/search/tmdb/${tmdbId}?id_type=${
            mediaType === 'movie' ? 'movie' : 'show'
          }`}
          className="w-8 opacity-50 transition duration-300 hover:opacity-100"
          target="_blank"
          rel="noreferrer"
        >
          <TraktLogo />
        </a>
      )}
    </div>
  );
};

export default ExternalLinkBlock;
