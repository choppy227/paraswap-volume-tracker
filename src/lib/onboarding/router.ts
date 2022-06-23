import * as express from 'express';
import { assert } from 'ts-essentials';
import {
  OnBoardingService,
  validateAccount,
  validateAccountWithResponse,
} from './service';
import {
  AccountNonValidError,
  AccountByUUIDNotFoundError,
  AuthorizationError,
  OnBoardingError,
  ValidationError,
} from './errors';
import { Utils } from '../utils';
import { isAddress } from '@ethersproject/address';
import * as parser from 'body-parser';

const logger = global.LOGGER('OnboardingRouter');

const router = express.Router();

router.get('/eligible-addresses', async (req, res) => {
  try {
    const blockNumber = !!req.query.blockNumber
      ? +req.query.blockNumber
      : undefined;

    if (!!blockNumber && isNaN(blockNumber))
      throw new ValidationError(
        'blockNumber should be either undefined or a number',
      );

    const addresses =
      await OnBoardingService.getInstance().getEligibleAddresses(blockNumber);

    return res.json(addresses);
  } catch (e) {
    logger.error(req.path, e);
    res.status(403).send({
      error:
        e instanceof OnBoardingError
          ? e.message
          : `onboarding: could not retrieve list of addressees`,
    });
  }
});

router.get('/check-eligibility/:address/:blockNumber', async (req, res) => {
  try {
    const address = req.params.address.toLowerCase();
    const blockNumber = +req.params.blockNumber;

    if (!isAddress(address))
      throw new ValidationError('pass an address as first param');
    if (isNaN(blockNumber))
      throw new ValidationError('pass a block number as second param');

    const isEligible = await OnBoardingService.getInstance().isAddressEligible(
      address,
      blockNumber,
    );

    return res.json({ isEligible });
  } catch (e) {
    logger.error(req.path, e);
    res.status(403).send({
      error:
        e instanceof OnBoardingError
          ? e.message
          : `onboarding: could not check eligibility`,
    });
  }
});

router.post('/submit-verified', async (req, res) => {
  try {
    assert(
      process.env.SUBMIT_ACCOUNT_API_KEY,
      'set SUBMIT_ACCOUNT_API_KEY env var',
    );

    if (req.headers['x-auth-token'] !== process.env.SUBMIT_ACCOUNT_API_KEY)
      throw new AuthorizationError();

    const account = req.body;

    if (!validateAccount(account)) throw new AccountNonValidError(account);

    account.email = account.email.toLowerCase();

    await OnBoardingService.getInstance().registerVerifiedAccount(account);

    return res.status(201).send('Ok');
  } catch (e) {
    logger.error(req.path, e);
    res.status(e instanceof AuthorizationError ? 401 : 403).send({
      error:
        e instanceof OnBoardingError
          ? e.message
          : `Unknown error on submitting verified`,
    });
  }
});

router.post('/waiting-list', async (req, res) => {
  try {
    const account = req.body;

    if (!validateAccountWithResponse(account))
      throw new AccountNonValidError(account);

    account.email = account.email.toLowerCase();
    account.profile = {
      // assign ip address to help on fraud protection
      ip: Utils.getIP(req),
    };
    account.referrer_id = !account.referrer_id
      ? undefined
      : account.referrer_id;

    const registeredAccount =
      await OnBoardingService.getInstance().submitAccountForWaitingList(
        account,
      );

    return res.status(201).json(registeredAccount);
  } catch (e) {
    logger.error(req.path, e);
    res.status(403).send({
      error:
        e instanceof OnBoardingError
          ? e.message
          : `Unknown error on submitting account for waiting list`,
    });
  }
});

router.get('/waiting-list/:uuid', async (req, res) => {
  try {
    const uuid = req.params.uuid;

    const registeredAccount =
      await OnBoardingService.getInstance().getAccountByUUID({ uuid });

    return res.json(registeredAccount);
  } catch (e) {
    logger.error(req.path, e);

    res.status(e instanceof AccountByUUIDNotFoundError ? 404 : 403).send({
      error:
        e instanceof OnBoardingError
          ? e.message
          : `Unknown error on retrieving account from waiting list`,
    });
  }
});

export default router;
