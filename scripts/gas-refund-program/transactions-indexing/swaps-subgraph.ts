import { assert } from 'ts-essentials';
import {
  CHAIN_ID_AVALANCHE,
  CHAIN_ID_BINANCE,
  CHAIN_ID_FANTOM,
  CHAIN_ID_MAINNET,
  CHAIN_ID_POLYGON,
} from '../../../src/lib/constants';
import {
  GasRefundDeduplicationStartEpoch,
  GasRefundTxOriginCheckStartEpoch,
} from '../../../src/lib/gas-refund';
import {
  queryPaginatedData,
  QueryPaginatedDataParams,
} from '../../../src/lib/utils/helpers';
import { thegraphClient } from '../../../src/lib/utils/data-providers-clients';

const REORGS_BLOCKHASH_BY_CHAIN_ID: Record<string, string[]> = {
  [CHAIN_ID_POLYGON]: [
    '0x2019b19233191f463805ce55f5aaedb139cff358408da5e3d145c20dab47dab5',
    '0x4c48a4abde9207bcde996f3aa48741114d2eb8a0fea8ccecab9583ee5f6da235',
    '0x59531b71968e5fff106aeb906d2cc8d0331fb29ed6b212c88d76657725786d99',
  ],
};

// Note: txGasUsed from thegraph is unsafe as it's actually txGasLimit https://github.com/graphprotocol/graph-node/issues/2619
const SwapsQuery = `
query ($number_gte: BigInt, $number_lt: BigInt, $first: Int, $skip: Int) {
	swaps(
		first: $first
    skip: $skip
		orderBy: blockNumber
		orderDirection: asc
		where: {
			timestamp_gte: $number_gte
			timestamp_lt: $number_lt
		}
	) {
    txHash
		txOrigin
		txGasPrice
		blockNumber
    timestamp
    initiator
	}
}
`;

const SwapsQueryBlockHash = `
query ($number_gte: BigInt, $number_lt: BigInt, $blockHashes: [Bytes!], $first: Int, $skip: Int) {
	swaps(
		first: $first
    skip: $skip
		orderBy: blockNumber
		orderDirection: asc
		where: {
			timestamp_gte: $number_gte
			timestamp_lt: $number_lt
      blockHash_not_in: $blockHashes
		}
	) {
    txHash
		txOrigin
		txGasPrice
		blockNumber
    timestamp
    initiator
	}
}
`;
const SubgraphURLs: { [network: number]: string } = {
  [CHAIN_ID_MAINNET]:
    'https://api.thegraph.com/subgraphs/name/paraswap/paraswap-subgraph',
  [CHAIN_ID_AVALANCHE]:
    'https://api.thegraph.com/subgraphs/name/paraswap/paraswap-subgraph-avalanche',
  [CHAIN_ID_BINANCE]:
    'https://api.thegraph.com/subgraphs/name/paraswap/paraswap-subgraph-bsc',
  [CHAIN_ID_POLYGON]:
    'https://api.thegraph.com/subgraphs/name/paraswap/paraswap-subgraph-polygon',
  [CHAIN_ID_FANTOM]:
    'https://api.thegraph.com/subgraphs/name/paraswap/paraswap-subgraph-fantom',
};

interface GetSuccessSwapsInput {
  startTimestamp: number;
  endTimestamp: number;
  chainId: number;
  epoch: number;
}

// get filtered by accounts swaps from the graphql endpoint
export async function getSuccessfulSwaps({
  startTimestamp,
  endTimestamp,
  chainId,
  epoch,
}: GetSuccessSwapsInput): Promise<SwapData[]> {
  const subgraphURL = SubgraphURLs[chainId];

  const regorgBlockHashes = REORGS_BLOCKHASH_BY_CHAIN_ID[chainId];

  const fetchSwaps = async ({ skip, pageSize }: QueryPaginatedDataParams) => {
    const variables = Object.assign(
      {},
      {
        number_gte: startTimestamp,
        number_lt: endTimestamp,
        skip,
        pageSize,
      },
      regorgBlockHashes
        ? {
            blockHashes: regorgBlockHashes,
          }
        : {},
    );

    const { data } = await thegraphClient.post<SwapsGQLRespose>(subgraphURL, {
      query: regorgBlockHashes ? SwapsQueryBlockHash : SwapsQuery,
      variables,
    });

    const swaps = data.data.swaps;

    return swaps;
  };

  const swaps = await queryPaginatedData(fetchSwaps, 100);

  if (epoch < GasRefundTxOriginCheckStartEpoch) {
    return swaps;
  }

  const swapsWithTxOriginEqMsgSender = swaps.filter(
    swap => swap.initiator.toLowerCase() === swap.txOrigin.toLowerCase(),
  );

  if (epoch < GasRefundDeduplicationStartEpoch) {
    return swapsWithTxOriginEqMsgSender;
  }

  const uniqSwapTxHashes = [
    ...new Set(swapsWithTxOriginEqMsgSender.map(swap => swap.txHash)),
  ];

  assert(
    uniqSwapTxHashes.length === swapsWithTxOriginEqMsgSender.length,
    'duplicates found',
  );

  return swapsWithTxOriginEqMsgSender;
}

interface SwapsGQLRespose {
  data: { swaps: SwapData[] };
}

export interface SwapData {
  txHash: string;
  txOrigin: string;
  initiator: string;
  txGasPrice: string;
  blockNumber: string;
  timestamp: string;
}
