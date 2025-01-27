import React from 'react';
import { useRouter } from 'next/router';
import type {
  TvResult,
  MovieResult,
  PersonResult,
} from '../../../server/models/Search';
import ListView from '../Common/ListView';
import { defineMessages, useIntl } from 'react-intl';
import Header from '../Common/Header';
import PageTitle from '../Common/PageTitle';
import Error from '../../pages/_error';
import useDiscover from '../../hooks/useDiscover';

const messages = defineMessages({
  search: 'Search',
  searchresults: 'Search Results',
});

const Search: React.FC = () => {
  const intl = useIntl();
  const router = useRouter();

  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
  } = useDiscover<MovieResult | TvResult | PersonResult>(
    `/api/v1/search`,
    {
      query: router.query.query,
    },
    { hideAvailable: false }
  );

  if (error) {
    return <Error statusCode={500} />;
  }

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.search)} />
      <div className="mt-1 mb-5">
        <Header>{intl.formatMessage(messages.searchresults)}</Header>
      </div>
      <ListView
        items={titles}
        isEmpty={isEmpty}
        isLoading={
          isLoadingInitialData || (isLoadingMore && (titles?.length ?? 0) > 0)
        }
        isReachingEnd={isReachingEnd}
        onScrollBottom={fetchMore}
      />
    </>
  );
};

export default Search;
