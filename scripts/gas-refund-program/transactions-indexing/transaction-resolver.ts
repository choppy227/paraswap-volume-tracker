/**
 * this file resolves transactions.
 * it is agnostic to sources, and works with both the graph and covalent.
 * it is also agnostic to chagnes introduced at certain epochs.
 * it bridges the gap between different sources, to ensure the same data
 * is returned either way. for example querying for swaps: the data will
 * come from subgraph before a certain epoch, and so gets augmented
 * with gas used data, whereas later we use covalent which has this already.
 *
 * the caller of functions in this util don't need to care about how the data
 * is resolved, that is the response of the code in this file.
 */
import { SPSPAddresses } from '../staking/spsp-stakes-tracker';
import { covalentGetTXsForContract } from './txs-covalent';
import { getTransactionGasUsed } from '../staking/covalent';
import StakesTracker from '../staking/stakes-tracker';
import { getSuccessfulSwaps } from './swaps-subgraph';
import { GasRefundTransaction, CovalentTransaction } from '../types';
import { GasRefundTxOriginCheckStartEpoch, GasRefundSwapSourceCovalentStartEpoch, AUGUSTUS_ADDRESS, GRP_MIN_STAKE } from '../../../src/lib/gas-refund';
import { CHAIN_ID_MAINNET, SAFETY_MODULE_ADDRESS } from '../../../src/lib/constants';

type GetAllTXsInput = {
  startTimestamp: number;
  endTimestamp: number;
  chainId: number;
  epoch: number;
  epochEndTimestamp: number;
}

export const getAllTXs = async ({ epoch, chainId, startTimestamp, endTimestamp, epochEndTimestamp }: GetAllTXsInput): Promise<GasRefundTransaction[]> => {

  const chainWhiteListedAddresses: Record<number, string[]> = {
    [CHAIN_ID_MAINNET]: [...SPSPAddresses, SAFETY_MODULE_ADDRESS]
  }
  const whiteListedAddresses = chainWhiteListedAddresses?.[chainId] ?? []

  // fetch swaps and contract (staking pools, safety module) txs
  const allTXs = (await Promise.all([
    getSwapTXs({epoch, chainId, startTimestamp, endTimestamp, epochEndTimestamp}),
    getContractsTXs({chainId, startTimestamp, endTimestamp, whiteListedAddresses })
  ])).flat()

  // sort to be chronological
  const allTXsChronological = allTXs.sort((a, b) => +(a.timestamp) - +(b.timestamp));

  return allTXsChronological;
}


/**
 * this will take an epoch, a chain, and two timespan values (min/max).
 * it will use subgraph for now (and augment gas data via a covalent call),
 * but later resolve to covalent after a certain epoch.
*/
type GetSwapTXsInput = {
  epoch: number;
  chainId: number;
  startTimestamp: number;
  endTimestamp: number;
  epochEndTimestamp: number;
}
export const getSwapTXs = async ({ epoch, chainId, startTimestamp, endTimestamp, epochEndTimestamp }: GetSwapTXsInput): Promise<GasRefundTransaction[]> => {
  const swaps: GasRefundTransaction[] = await (async () => {
    // todo: epoch check when we change over - remove `false &&`
    if (false && epoch >= GasRefundSwapSourceCovalentStartEpoch) {
      // get from covalent
      const swapsFromCovalent = await covalentGetTXsForContract({
        startTimestamp,
        endTimestamp,
        chainId,
        contract: AUGUSTUS_ADDRESS
      });
      const normalisedSwapsFromCovalent = swapsFromCovalent.map(swap => ({
        ...swap,
        blockNumber: swap.blockNumber.toString()
      }));
      return normalisedSwapsFromCovalent;
    } else {
      // get swaps from the graph
      const swaps = await getSuccessfulSwaps({ startTimestamp, endTimestamp, chainId, epoch });

      // check the swapper is a staker to avoid subsequently wasting resources looking up gas unnecessarily
      const swapsOfQualifyingStakers = swaps.filter(swap => {
        const swapperStake = StakesTracker.getInstance().computeStakedPSPBalance(
          swap.txOrigin,
          +swap.timestamp,
          epoch,
          epochEndTimestamp
        );
        return !swapperStake.isLessThan(GRP_MIN_STAKE);
      });

      // augment with gas used
      const swapsWithGasUsedNormalised: GasRefundTransaction[] = await Promise.all(
        swapsOfQualifyingStakers.map(async ({
          txHash,
          txOrigin,
          txGasPrice,
          timestamp,
          blockNumber
        }) => {
          const txGasUsed = await getTransactionGasUsed({
            chainId,
            txHash,
          });

          return {
            txHash,
            txOrigin,
            txGasPrice,
            timestamp,
            blockNumber,
            txGasUsed: txGasUsed.toString()
          }
        })
      );

      return swapsWithGasUsedNormalised;
    }
  })()


  return swaps;
}

/**
 * staking and unstaking txs.
 * call covalent and get all txs within a period for a staking contract. do this
 * for all staking contracts.
 */
type GetContractsTXsInput = {
  chainId: number;
  startTimestamp: number;
  endTimestamp: number;
  whiteListedAddresses: string[]
}
export const getContractsTXs = async ({
  startTimestamp,
  endTimestamp,
  chainId,
  whiteListedAddresses
}: GetContractsTXsInput): Promise<GasRefundTransaction[]> => {

  const getTxsFromAllContracts = [...Array(whiteListedAddresses.length).keys()].map((i) => covalentGetTXsForContract({
    startTimestamp,
    endTimestamp,
    chainId,
    contract: whiteListedAddresses[i]
  }));
  const txsAcrossContracts = await Promise.all(getTxsFromAllContracts);

  const txsFromAllContracts = [].concat.apply([], txsAcrossContracts) as CovalentTransaction[];

  // sort to be chronological
  const chronologicalTxs = txsFromAllContracts.sort((a, b) => +(a.timestamp) - +(b.timestamp));

  const normalisedTXs: GasRefundTransaction[] = chronologicalTxs.map(tx => ({
    ...tx,
    blockNumber: tx.blockNumber.toString()
  }))

  return normalisedTXs;
}
