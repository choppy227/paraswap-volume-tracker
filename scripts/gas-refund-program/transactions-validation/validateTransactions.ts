import BigNumber from 'bignumber.js';
import { Op } from 'sequelize';
import { assert } from 'ts-essentials';
import {
  GasRefundBudgetLimitEpochBasedStartEpoch,
  GasRefundGenesisEpoch,
  GasRefundPrecisionGlitchRefundedAmountsEpoch,
  getRefundPercent,
  TOTAL_EPOCHS_IN_YEAR,
  TransactionStatus,
} from '../../../src/lib/gas-refund';
import { GasRefundTransaction } from '../../../src/models/GasRefundTransaction';
import {
  fetchLastEpochRefunded,
  updateTransactionsStatusRefundedAmounts,
} from '../persistance/db-persistance';
import { xnor } from '../../../src/lib/utils/helpers';
import {
  GRPBudgetGuardian,
  MAX_PSP_GLOBAL_BUDGET_YEARLY,
  MAX_USD_ADDRESS_BUDGET_YEARLY,
  MAX_USD_ADDRESS_BUDGET_EPOCH,
} from './GRPBudgetGuardian';

/**
 * This function guarantees that the order of transactions refunded will always be stable.
 * This is particularly important as we approach either per-address or global budget limit.
 * Because some transactions from some data source can arrive later, we need to reassess the status of all transactions for all chains for whole epoch.
 *
 * The solution is to:
 * - load current budgetGuardian to get snapshot of budgets spent
 * - scan all transaction since last epoch refunded in batch
 * - flag each transaction as either validated or rejected if it reached the budget
 * - update in memory budget accountability through budgetGuardian on validated transactions
 * - write back status of tx in database if changed
 */
export async function validateTransactions() {
  const guardian = GRPBudgetGuardian.getInstance();

  const lastEpochRefunded = await fetchLastEpochRefunded();
  const startEpochForTxValidation = !lastEpochRefunded
    ? GasRefundGenesisEpoch
    : lastEpochRefunded + 1;

  // reload budget guardian state till last epoch refunded (exclusive)
  await guardian.loadStateFromDB(startEpochForTxValidation);

  let offset = 0;
  const pageSize = 1000;

  while (true) {
    // scan transactions in batch sorted by timestamp and hash to guarantee stability
    const transactionsSlice = await GasRefundTransaction.findAll({
      where: {
        epoch: {
          [Op.gte]: startEpochForTxValidation,
        },
      },
      order: ['timestamp', 'hash'],
      limit: pageSize,
      offset,
      raw: true,
      attributes: [
        'id',
        'chainId',
        'epoch',
        'hash',
        'address',
        'status',
        'totalStakeAmountPSP',
        'gasUsedChainCurrency',
        'pspChainCurrency',
        'pspUsd',
        'refundedAmountUSD',
        'refundedAmountPSP',
      ],
    });

    if (!transactionsSlice.length) break;

    offset += pageSize;

    const updatedTransactions = [];

    let prevEpoch = transactionsSlice[0].epoch;

    for (const tx of transactionsSlice) {
      const {
        address,
        status,
        totalStakeAmountPSP,
        gasUsedChainCurrency,
        pspChainCurrency,
        pspUsd,
      } = tx;
      let newStatus;

      if (prevEpoch !== tx.epoch) {
        // clean epoch based state on each epoch change
        guardian.cleanEpochBudgetState();

        // clean yearly based state every 26 epochs
        if ((tx.epoch - GasRefundGenesisEpoch) % TOTAL_EPOCHS_IN_YEAR === 0) {
          guardian.cleanYearlyBudgetState();
        }

        prevEpoch = tx.epoch;
      }

      const refundPercentage = getRefundPercent(totalStakeAmountPSP);

      assert(refundPercentage, 'refundPercentage should be defined and > 0');

      // recompute refundedAmountPSP/refundedAmountUSD as logic alters those values as we reach limits
      let _refundedAmountPSP = new BigNumber(gasUsedChainCurrency)
        .dividedBy(pspChainCurrency)
        .multipliedBy(refundPercentage); // keep it decimals to avoid rounding errors

      if (tx.epoch === GasRefundPrecisionGlitchRefundedAmountsEpoch) {
        _refundedAmountPSP = _refundedAmountPSP.decimalPlaces(0);
      }

      const refundedAmountUSD = _refundedAmountPSP
        .multipliedBy(pspUsd)
        .dividedBy(10 ** 18); // psp decimals always encoded in 18decimals

      const refundedAmountPSP = _refundedAmountPSP.decimalPlaces(0); // truncate decimals to align with values in db

      if (
        guardian.isMaxYearlyPSPGlobalBudgetSpent() ||
        guardian.hasSpentYearlyUSDBudget(address) ||
        (tx.epoch >= GasRefundBudgetLimitEpochBasedStartEpoch &&
          guardian.hasSpentUSDBudgetForEpoch(address))
      ) {
        newStatus = TransactionStatus.REJECTED;
      } else {
        newStatus = TransactionStatus.VALIDATED;

        let { cappedRefundedAmountPSP, cappedRefundedAmountUSD } =
          tx.epoch < GasRefundBudgetLimitEpochBasedStartEpoch
            ? capRefundedAmountsBasedOnYearlyDollarBudget(
                address,
                refundedAmountUSD,
                pspUsd,
              )
            : capRefundedAmountsBasedOnEpochDollarBudget(
                address,
                refundedAmountUSD,
                pspUsd,
              );

        cappedRefundedAmountPSP = capRefundedPSPAmountBasedOnPSPBudget(
          cappedRefundedAmountPSP,
          refundedAmountPSP,
        );

        if (tx.epoch >= GasRefundBudgetLimitEpochBasedStartEpoch) {
          guardian.increaseRefundedUSDForEpoch(
            address,
            cappedRefundedAmountUSD || refundedAmountUSD,
          );
        }

        guardian.increaseYearlyRefundedUSD(
          address,
          cappedRefundedAmountUSD || refundedAmountUSD,
        );

        guardian.increaseTotalRefundedPSP(
          cappedRefundedAmountPSP || refundedAmountPSP,
        );

        assert(
          xnor(cappedRefundedAmountPSP, cappedRefundedAmountUSD),
          'Either both cappedRefundedAmountPSP and cappedRefundedAmountUSD should be falsy or truthy',
        );

        if (status !== newStatus || !!cappedRefundedAmountPSP) {
          updatedTransactions.push({
            ...tx,
            ...(!!cappedRefundedAmountPSP
              ? { refundedAmountPSP: cappedRefundedAmountPSP.toFixed(0) }
              : {}),
            ...(!!cappedRefundedAmountUSD
              ? { refundedAmountUSD: cappedRefundedAmountUSD.toFixed() } // purposefully not rounded to preserve dollar amount precision [IMPORTANT FOR CALCULCATIONS]
              : {}),
            status: newStatus,
          });
        }
      }

      if (updatedTransactions.length > 0) {
        await updateTransactionsStatusRefundedAmounts(updatedTransactions);
      }

      if (transactionsSlice.length < pageSize) break; // micro opt to avoid querying db for last page
    }

    const numOfIdleTxs = await GasRefundTransaction.count({
      where: { status: TransactionStatus.IDLE },
    });

    assert(
      numOfIdleTxs === 0,
      `there should be 0 idle transactions at the end of validation step`,
    );
  }
}

type CappedAmounts = {
  cappedRefundedAmountUSD: BigNumber | undefined;
  cappedRefundedAmountPSP: BigNumber | undefined;
};

function capRefundedAmountsBasedOnYearlyDollarBudget(
  address: string,
  refundedAmountUSD: BigNumber,
  pspUsd: number,
): CappedAmounts {
  const guardian = GRPBudgetGuardian.getInstance();
  let cappedRefundedAmountUSD;
  let cappedRefundedAmountPSP;

  if (
    guardian
      .totalYearlyRefundedUSD(address)
      .plus(refundedAmountUSD)
      .isGreaterThan(MAX_USD_ADDRESS_BUDGET_YEARLY)
  ) {
    cappedRefundedAmountUSD = MAX_USD_ADDRESS_BUDGET_YEARLY.minus(
      guardian.totalYearlyRefundedUSD(address),
    );

    assert(
      cappedRefundedAmountUSD.isGreaterThanOrEqualTo(0),
      'Logic Error: quantity cannot be negative, this would mean we priorly refunded more than max',
    );

    cappedRefundedAmountPSP = cappedRefundedAmountUSD
      .dividedBy(pspUsd)
      .multipliedBy(10 ** 18)
      .decimalPlaces(0);
  }

  return { cappedRefundedAmountUSD, cappedRefundedAmountPSP };
}

function capRefundedAmountsBasedOnEpochDollarBudget(
  address: string,
  refundedAmountUSD: BigNumber,
  pspUsd: number,
): CappedAmounts {
  const guardian = GRPBudgetGuardian.getInstance();

  if (
    guardian
      .totalYearlyRefundedUSD(address)
      .plus(refundedAmountUSD)
      .isGreaterThan(MAX_USD_ADDRESS_BUDGET_YEARLY)
  ) {
    return capRefundedAmountsBasedOnYearlyDollarBudget(
      address,
      refundedAmountUSD,
      pspUsd,
    );
  }

  let cappedRefundedAmountUSD;
  let cappedRefundedAmountPSP;

  if (
    guardian
      .totalRefundedUSDForEpoch(address)
      .plus(refundedAmountUSD)
      .isGreaterThan(MAX_USD_ADDRESS_BUDGET_EPOCH)
  ) {
    cappedRefundedAmountUSD = MAX_USD_ADDRESS_BUDGET_EPOCH.minus(
      guardian.totalRefundedUSDForEpoch(address),
    );

    assert(
      cappedRefundedAmountUSD.isGreaterThanOrEqualTo(0),
      'Logic Error: quantity cannot be negative, this would mean we priorly refunded more than max',
    );

    cappedRefundedAmountPSP = cappedRefundedAmountUSD
      .dividedBy(pspUsd)
      .multipliedBy(10 ** 18)
      .decimalPlaces(0);
  }

  return { cappedRefundedAmountUSD, cappedRefundedAmountPSP };
}

function capRefundedPSPAmountBasedOnPSPBudget(
  cappedRefundedAmountPSP: BigNumber | undefined,
  refundedAmountPSP: BigNumber,
): BigNumber | undefined {
  const guardian = GRPBudgetGuardian.getInstance();

  if (
    guardian.state.totalPSPRefundedForYear
      .plus(cappedRefundedAmountPSP || refundedAmountPSP)
      .isGreaterThan(MAX_PSP_GLOBAL_BUDGET_YEARLY)
  ) {
    // Note: updating refundedAmountUSD does not matter if global budget limit is reached
    const cappedToMax = MAX_PSP_GLOBAL_BUDGET_YEARLY.minus(
      guardian.state.totalPSPRefundedForYear,
    );

    // if transaction has been capped in upper handling, take min to avoid accidentally pushing per address limit
    cappedRefundedAmountPSP = cappedRefundedAmountPSP
      ? BigNumber.min(cappedRefundedAmountPSP, cappedToMax)
      : cappedToMax;

    assert(
      cappedRefundedAmountPSP.lt(refundedAmountPSP),
      'the capped amount should be lower than original one',
    );

    return cappedRefundedAmountPSP;
  }

  return cappedRefundedAmountPSP;
}
