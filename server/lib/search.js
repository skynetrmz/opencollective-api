/**
 * Functions related to search
 */

import config from 'config';
import { sortBy, get } from 'lodash';

import { CollectiveTypesList } from '../constants/collectives';
import { RateLimitExceeded } from '../graphql/errors';
import models, { Op, sequelize } from '../models';
import algolia from './algolia';
import cache from './cache';

// Returned when there's no result for a search
const EMPTY_SEARCH_RESULT = [[], 0];

/**
 * Search users by email address. `user` must be set because this endpoint is rate
 * limited to prevent abuse.
 *
 * @param {String} email - a valid email address
 * @param {Object} user - the user triggering the search
 */
export const searchCollectivesByEmail = async (email, user, offset = 0, limit = 10) => {
  if (!email || !user) {
    return EMPTY_SEARCH_RESULT;
  }

  // Put some rate limiting to users can't use this endpoint to bruteforce emails
  const maxChangePerHour = config.limits.searchEmailPerHour;
  const countCacheKey = `user_email_search_${user.id}`;
  const existingCount = (await cache.get(countCacheKey)) || 0;
  if (existingCount > maxChangePerHour) {
    throw new RateLimitExceeded();
  } else {
    // Update the cache
    const oneHourInSeconds = 60 * 60;
    cache.set(countCacheKey, existingCount + 1, oneHourInSeconds);
  }

  // Emails are uniques, thus there should never be more than one result - this is
  // why it's safe to use `collectives.length` in the return.
  const collectives = await sequelize.query(
    `
    SELECT  c.*, COUNT(*) OVER() AS __total__
    FROM "Collectives" c
    INNER JOIN "Users" u ON u."CollectiveId" = c.id
    WHERE c."isIncognito" = FALSE AND c.type = 'USER' AND u.email = :email
    OFFSET :offset
    LIMIT :limit
    `,
    {
      model: models.Collective,
      mapToModel: true,
      replacements: { offset, limit, email },
    },
  );

  return [collectives, get(collectives[0], 'dataValues.__total__', 0)];
};

/**
 * Turn a search string into a TS vector using 'OR' operator.
 *
 * Ex: "open potatoes" => "open|potatoes"
 */
const searchTermToTsVector = term => {
  return term
    .trim()
    .split(/\s+/g)
    .join('|');
};

/**
 * Search collectives directly in the DB, using a full-text query.
 */
export const searchCollectivesInDB = async (term, offset = 0, limit = 100, types) => {
  const tsVector = `
    to_tsvector('simple', c.name)
    || to_tsvector('simple', c.slug)
    || to_tsvector('simple', COALESCE(c.description, ''))
  `;

  const result = await sequelize.query(
    `
    SELECT 
      c.*, 
      COUNT(*) OVER() AS __total__,
      ts_rank(${tsVector}, to_tsquery('simple', :term)) AS __rank__
    FROM "Collectives" c
    WHERE ${tsVector} @@ to_tsquery('simple', :term)
    AND type IN (:types)
    ORDER BY __rank__ DESC
    OFFSET :offset
    LIMIT :limit
    `,
    {
      model: models.Collective,
      mapToModel: true,
      replacements: {
        types: types || CollectiveTypesList,
        term: searchTermToTsVector(term),
        offset,
        limit,
      },
    },
  );

  return [result, get(result[0], 'dataValues.__total__', 0)];
};

/**
 * Search for collectives using Algolia.
 *
 * @returns a tuple like [collectives, total]
 */
export const searchCollectivesOnAlgolia = async (term, offset, limit, types) => {
  const index = algolia.getIndex();
  if (!index) {
    return EMPTY_SEARCH_RESULT;
  }

  const { hits, nbHits: total } = await index.search({
    query: term,
    length: limit,
    offset,
  });

  const collectiveIds = hits.map(({ id }) => id);

  if (collectiveIds.length === 0) {
    return EMPTY_SEARCH_RESULT;
  }

  // Build and run SQL query
  const where = { id: { [Op.in]: collectiveIds } };
  if (types !== undefined) {
    where.type = { [Op.in]: types };
  }

  const collectives = await models.Collective.findAll({ where });
  const sortedCollectives = sortBy(collectives, collective => collectiveIds.indexOf(collective.id));
  return [sortedCollectives, total];
};
