import axios from 'axios';
import { setupCache } from 'axios-cache-adapter';
import * as _ from 'lodash';
import { assert } from 'ts-essentials';
import { AccountToCreate, RegisteredAccount } from './types';

const logger = global.LOGGER('MailService');

const { MAIL_SERVICE_BASE_URL, MAIL_SERVICE_API_KEY } = process.env;

type MinStore = {
  // store is typed as object in lib
  clear: () => void;
};

const cache = setupCache({
  maxAge: 60 * 1000,
  limit: 1,
  exclude: {
    query: false, // apikey is passed through query param
  },
  invalidate: async (cfg, req) => {
    const method = req?.method?.toLowerCase();
    if (method !== 'get') {
      // account creation would clear store and force refetching list of accounts
      await (cfg?.store as MinStore)?.clear();
    }
  },
});

const cachedAxios = axios.create({
  adapter: cache.adapter,
});

export class AccountCreationError extends Error {
  constructor(account: AccountToCreate) {
    super(
      `AccountCreationError: account=${JSON.stringify(
        account,
      )} did not get created.`,
    );
  }
}

export class DuplicatedAccountError extends Error {
  constructor(account: AccountToCreate) {
    super(`DuplicatedErrorAccount: account=${JSON.stringify(account)}`);
  }
}

type RawRegisteredAccount = RegisteredAccount & Record<string, unknown>;

function sanitizeAccount(
  rawRegisteredAccount: RawRegisteredAccount,
): RegisteredAccount {
  return _.pick(rawRegisteredAccount, [
    'uuid',
    'email',
    'status',
    'share_clicks_count',
    'share_signups_count',
    'share_link',
    'share_status_link',
    'waitlist_position',
  ]);
}

// service present some latency (5min observed). Creating account then trying to retrieve it right away would likely fail.
export async function createNewAccount(
  account: AccountToCreate,
  isVerified: boolean,
): Promise<RegisteredAccount> {
  assert(MAIL_SERVICE_BASE_URL, 'set MAIL_SERVICE_BASE_URL env var');
  assert(MAIL_SERVICE_API_KEY, 'set MAIL_SERVICE_API_KEY env var');

  const apiUrl = `${MAIL_SERVICE_BASE_URL}/betas/17942/testers?api_key=${MAIL_SERVICE_API_KEY}`;

  const { email } = account;

  const accountMail = isVerified
    ? {
        email,
        status: 'imported',
        groups: 'PSP stakers',
      }
    : {
        email,
        status: 'applied',
      };

  try {
    const { data: registeredAccount } =
      await cachedAxios.post<RawRegisteredAccount>(apiUrl, accountMail);

    return sanitizeAccount(registeredAccount);
  } catch (e) {
    logger.error(e);
    if (e.response?.data?.errors?.[0]?.code === 2310)
      throw new DuplicatedAccountError(account);

    throw new AccountCreationError(account);
  }
}

// Note: service allows to search by uuid but not email. Prefer fetching list (cached) and do in memory lookup to fit all use cases.
export async function fetchAccounts(): Promise<RegisteredAccount[]> {
  assert(MAIL_SERVICE_BASE_URL, 'set MAIL_SERVICE_BASE_URL env var');
  assert(MAIL_SERVICE_API_KEY, 'set MAIL_SERVICE_API_KEY env var');

  const apiUrl = `${MAIL_SERVICE_BASE_URL}/betas/17942/testers?api_key=${MAIL_SERVICE_API_KEY}`;

  try {
    const { data: registeredAccounts } = await cachedAxios.get<
      RawRegisteredAccount[]
    >(apiUrl);

    return registeredAccounts.map(sanitizeAccount);
  } catch (e) {
    logger.error(e);
    throw e;
  }
}
