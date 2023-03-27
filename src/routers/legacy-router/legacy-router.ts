import { BigNumber } from '@ethersproject/bignumber';
import { Logger } from '@ethersproject/logger';
import { BaseProvider } from '@ethersproject/providers';
import { SwapRouter, Trade } from '@totality-fi/router-sdk';
import { Route } from '@totality-fi/v1-sdk';
import { Pair } from '@totality-fi/v1-sdk';
import DEFAULT_TOKEN_LIST from '@uniswap/default-token-list';
import { Currency, Token, TradeType } from '@uniswap/sdk-core';
import { MethodParameters } from '@uniswap/v3-sdk';
import _ from 'lodash';
import NodeCache from 'node-cache';

import {
  CachingTokenListProvider,
  CachingTokenProviderWithFallback,
  CachingV2PoolProvider,
  IV2PoolProvider,
  NodeJSCache,
  RouteWithQuotes,
  TokenProvider,
  UniswapMulticallProvider,
  V2PoolProvider,
  V2QuoteProvider, V2RouteWithQuotes
} from '../../providers';
import { IMulticallProvider } from '../../providers/multicall-provider';
import {
  DAI_MAINNET,
  ITokenProvider,
  USDC_MAINNET,
} from '../../providers/token-provider';
import { SWAP_ROUTER_02_ADDRESSES } from '../../util';
import { CurrencyAmount } from '../../util/amounts';
import { ChainId } from '../../util/chains';
import { log } from '../../util/log';
import { routeToString } from '../../util/routes';
import { V2RouteWithValidQuote } from '../alpha-router';
import {
  SwapOptionsSwapRouter02,
  SwapRoute,
  V2Route
} from '../router';

import {
  ADDITIONAL_BASES,
  BASES_TO_CHECK_TRADES_AGAINST,
  CUSTOM_BASES,
} from './bases';


export type LegacyRouterParams = {
  chainId: ChainId;
  provider: BaseProvider;
};

// Interface defaults to 2.
const MAX_HOPS = 2;

export type LegacyRoutingConfig = {
  blockNumber?: number;
};

/**
 * Replicates the router implemented in the V3 interface.
 * Code is mostly a copy from https://github.com/Uniswap/uniswap-interface/blob/0190b5a408c13016c87e1030ffc59326c085f389/src/hooks/useBestV3Trade.ts#L22-L23
 * with React/Redux hooks removed, and refactoring to allow re-use in other routers.
 */
export class LegacyRouter {
  protected chainId: ChainId;
  protected multicall2Provider: IMulticallProvider;
  protected poolProvider: IV2PoolProvider;
  protected quoteProvider: V2QuoteProvider;
  protected tokenProvider: ITokenProvider;

  constructor({
    chainId,
    provider
  }: LegacyRouterParams) {
    this.chainId = chainId;

    this.multicall2Provider = new UniswapMulticallProvider(chainId, provider, 375_000);

    this.poolProvider =
      new CachingV2PoolProvider(
        chainId,
        new V2PoolProvider(chainId, this.multicall2Provider),
        new NodeJSCache(new NodeCache({ stdTTL: 60, useClones: false }))
      );

    this.quoteProvider = new V2QuoteProvider();

    this.tokenProvider =
      new CachingTokenProviderWithFallback(
        chainId,
        new NodeJSCache(new NodeCache({ stdTTL: 3600, useClones: false })),
        new CachingTokenListProvider(
          chainId,
          DEFAULT_TOKEN_LIST,
          new NodeJSCache(new NodeCache({ stdTTL: 3600, useClones: false }))
        ),
        new TokenProvider(chainId, this.multicall2Provider)
      );
  }
  public async route(
    amount: CurrencyAmount,
    quoteCurrency: Currency,
    swapType: TradeType,
    swapConfig?: SwapOptionsSwapRouter02,
    partialRoutingConfig?: Partial<LegacyRoutingConfig>
  ): Promise<SwapRoute | null> {
    if (swapType == TradeType.EXACT_INPUT) {
      return this.routeExactIn(
        amount.currency,
        quoteCurrency,
        amount,
        swapConfig,
        partialRoutingConfig
      );
    }

    return this.routeExactOut(
      quoteCurrency,
      amount.currency,
      amount,
      swapConfig,
      partialRoutingConfig
    );
  }

  public async routeExactIn(
    currencyIn: Currency,
    currencyOut: Currency,
    amountIn: CurrencyAmount,
    swapConfig?: SwapOptionsSwapRouter02,
    routingConfig?: LegacyRoutingConfig
  ): Promise<SwapRoute | null> {
    const tokenIn = currencyIn.wrapped;
    const tokenOut = currencyOut.wrapped;
    const routes = await this.getAllRoutes(tokenIn, tokenOut, routingConfig);
    const routeQuote = await this.findBestRouteExactIn(
      amountIn,
      tokenOut,
      routes
    );

    if (!routeQuote) {
      return null;
    }

    const trade = this.buildTrade<TradeType.EXACT_INPUT>(
      currencyIn,
      currencyOut,
      TradeType.EXACT_INPUT,
      routeQuote
    );

    return {
      quote: routeQuote.quote,
      quoteGasAdjusted: routeQuote.quote,
      route: [routeQuote],
      estimatedGasUsed: BigNumber.from(0),
      estimatedGasUsedQuoteToken: CurrencyAmount.fromFractionalAmount(
        tokenOut,
        0,
        1
      ),
      estimatedGasUsedUSD: CurrencyAmount.fromFractionalAmount(
        DAI_MAINNET!,
        0,
        1
      ),
      gasPriceWei: BigNumber.from(0),
      trade,
      methodParameters: swapConfig
        ? {
            ...this.buildMethodParameters(trade, swapConfig),
            to: SWAP_ROUTER_02_ADDRESSES(this.chainId),
          }
        : undefined,
      blockNumber: BigNumber.from(0),
    };
  }

  public async routeExactOut(
    currencyIn: Currency,
    currencyOut: Currency,
    amountOut: CurrencyAmount,
    swapConfig?: SwapOptionsSwapRouter02,
    routingConfig?: LegacyRoutingConfig
  ): Promise<SwapRoute | null> {
    const tokenIn = currencyIn.wrapped;
    const tokenOut = currencyOut.wrapped;
    const routes = await this.getAllRoutes(tokenIn, tokenOut, routingConfig);
    const routeQuote = await this.findBestRouteExactOut(
      amountOut,
      tokenIn,
      routes
    );

    if (!routeQuote) {
      return null;
    }

    const trade = this.buildTrade<TradeType.EXACT_OUTPUT>(
      currencyIn,
      currencyOut,
      TradeType.EXACT_OUTPUT,
      routeQuote
    );

    return {
      quote: routeQuote.quote,
      quoteGasAdjusted: routeQuote.quote,
      route: [routeQuote],
      estimatedGasUsed: BigNumber.from(0),
      estimatedGasUsedQuoteToken: CurrencyAmount.fromFractionalAmount(
        tokenIn,
        0,
        1
      ),
      estimatedGasUsedUSD: CurrencyAmount.fromFractionalAmount(
        DAI_MAINNET,
        0,
        1
      ),
      gasPriceWei: BigNumber.from(0),
      trade,
      methodParameters: swapConfig
        ? {
            ...this.buildMethodParameters(trade, swapConfig),
            to: SWAP_ROUTER_02_ADDRESSES(this.chainId),
          }
        : undefined,
      blockNumber: BigNumber.from(0),
    };
  }

  private async findBestRouteExactIn(
    amountIn: CurrencyAmount,
    tokenOut: Token,
    routes: V2Route[]
  ): Promise<V2RouteWithValidQuote | null> {
    const { routesWithQuotes: quotesRaw } =
      await this.quoteProvider.getQuotesManyExactIn(
        [amountIn],
        routes
      );

    const quotes100Percent = _.map(
      quotesRaw,
      ([route, quotes]: RouteWithQuotes<V2Route>) =>
        `${routeToString(route)} : ${quotes[0]?.quote?.toString()}`
    );
    log.info({ quotes100Percent }, '100% Quotes');

    const bestQuote = await this.getBestQuote(
      routes,
      quotesRaw,
      tokenOut,
      TradeType.EXACT_INPUT
    );

    return bestQuote;
  }

  private async findBestRouteExactOut(
    amountOut: CurrencyAmount,
    tokenIn: Token,
    routes: V2Route[]
  ): Promise<V2RouteWithValidQuote | null> {
    const { routesWithQuotes: quotesRaw } =
      await this.quoteProvider.getQuotesManyExactOut(
        [amountOut],
        routes
      );
    const bestQuote = await this.getBestQuote(
      routes,
      quotesRaw,
      tokenIn,
      TradeType.EXACT_OUTPUT
    );

    return bestQuote;
  }

  private async getBestQuote(
    routes: V2Route[],
    quotesRaw: V2RouteWithQuotes[],
    quoteToken: Token,
    routeType: TradeType
  ): Promise<V2RouteWithValidQuote | null> {
    log.debug(
      `Got ${
        _.filter(quotesRaw, ([_, quotes]) => !!quotes[0]).length
      } valid quotes from ${routes.length} possible routes.`
    );

    const routeQuotesRaw: {
      route: V2Route;
      quote: BigNumber;
      amount: CurrencyAmount;
    }[] = [];

    for (let i = 0; i < quotesRaw.length; i++) {
      const [route, quotes] = quotesRaw[i]!;
      const { quote, amount } = quotes[0]!;

      if (!quote) {
        Logger.globalLogger().debug(`No quote for ${routeToString(route)}`);
        continue;
      }

      routeQuotesRaw.push({ route, quote, amount });
    }

    if (routeQuotesRaw.length == 0) {
      return null;
    }

    routeQuotesRaw.sort((routeQuoteA, routeQuoteB) => {
      if (routeType == TradeType.EXACT_INPUT) {
        return routeQuoteA.quote.gt(routeQuoteB.quote) ? -1 : 1;
      } else {
        return routeQuoteA.quote.lt(routeQuoteB.quote) ? -1 : 1;
      }
    });

    const routeQuotes = _.map(routeQuotesRaw, ({ route, quote, amount }) => {
      return new V2RouteWithValidQuote({
        route,
        rawQuote: quote,
        amount,
        percent: 100,
        gasModel: {
          estimateGasCost: () => ({
            gasCostInToken: CurrencyAmount.fromRawAmount(quoteToken, 0),
            gasCostInUSD: CurrencyAmount.fromRawAmount(USDC_MAINNET, 0),
            gasEstimate: BigNumber.from(0),
          }),
        },
        tradeType: routeType,
        quoteToken,
        v2PoolProvider: this.poolProvider,
      });
    });

    for (const rq of routeQuotes) {
      log.debug(
        `Quote: ${rq.amount.toFixed(
          Math.min(rq.amount.currency.decimals, 2)
        )} Route: ${routeToString(rq.route)}`
      );
    }

    return routeQuotes[0]!;
  }

  private async getAllRoutes(
    tokenIn: Token,
    tokenOut: Token,
    routingConfig?: LegacyRoutingConfig
  ): Promise<V2Route[]> {
    const tokenPairs: [Token, Token][] =
      await this.getAllPossiblePairings(tokenIn, tokenOut);

    const poolAccessor = await this.poolProvider.getPools(tokenPairs, {
      blockNumber: routingConfig?.blockNumber,
    });
    const pools = poolAccessor.getAllPools();

    const routes: V2Route[] = this.computeAllRoutes(
      tokenIn,
      tokenOut,
      pools,
      this.chainId,
      [],
      [],
      tokenIn,
      MAX_HOPS
    );

    log.info(
      { routes: _.map(routes, routeToString) },
      `Computed ${routes.length} possible routes.`
    );

    return routes;
  }

  private async getAllPossiblePairings(
    tokenIn: Token,
    tokenOut: Token
  ): Promise<[Token, Token][]> {
    const common =
      BASES_TO_CHECK_TRADES_AGAINST(this.tokenProvider)[this.chainId] ?? [];
    const additionalA =
      (await ADDITIONAL_BASES(this.tokenProvider))[this.chainId]?.[
        tokenIn.address
      ] ?? [];
    const additionalB =
      (await ADDITIONAL_BASES(this.tokenProvider))[this.chainId]?.[
        tokenOut.address
      ] ?? [];
    const bases = [...common, ...additionalA, ...additionalB];

    const basePairs: [Token, Token][] = _.flatMap(
      bases,
      (base): [Token, Token][] => bases.map((otherBase) => [base, otherBase])
    );

    const customBases = (await CUSTOM_BASES(this.tokenProvider))[this.chainId];

    //This only actually generates all pairs between the common tokens
    const allPairs: [Token, Token][] = _([
      // the direct pair
      [tokenIn, tokenOut],
      // token A against all bases
      ...bases.map((base): [Token, Token] => [tokenIn, base]),
      // token B against all bases
      ...bases.map((base): [Token, Token] => [tokenOut, base]),
      // each base against all bases
      ...basePairs,
    ])
      .filter((tokens): tokens is [Token, Token] =>
        Boolean(tokens[0] && tokens[1])
      )
      .filter(
        ([tokenA, tokenB]) =>
          tokenA.address !== tokenB.address && !tokenA.equals(tokenB)
      )
      .filter(([tokenA, tokenB]) => {
        const customBasesA: Token[] | undefined = customBases?.[tokenA.address];
        const customBasesB: Token[] | undefined = customBases?.[tokenB.address];

        if (!customBasesA && !customBasesB) return true;

        if (customBasesA && !customBasesA.find((base) => tokenB.equals(base)))
          return false;
        if (customBasesB && !customBasesB.find((base) => tokenA.equals(base)))
          return false;

        return true;
      })
      .value();

    return allPairs;
  }

  private computeAllRoutes(
    tokenIn: Token,
    tokenOut: Token,
    pools: Pair[],
    chainId: ChainId,
    currentPath: Pair[] = [],
    allPaths: V2Route[] = [],
    startTokenIn: Token = tokenIn,
    maxHops = 2
  ): V2Route[] {
    for (const pool of pools) {
      //Skip pools not related to our tokenIn
      if (currentPath.indexOf(pool) !== -1 || !pool.involvesToken(tokenIn))
        continue;

      const outputToken = pool.token0.equals(tokenIn)
        ? pool.token1
        : pool.token0;
      if (outputToken.equals(tokenOut)) {
        allPaths.push(
          new V2Route([...currentPath, pool], startTokenIn, tokenOut)
        );
      } else if (maxHops > 1) {
        //Recall this with the
        this.computeAllRoutes(
          outputToken,
          tokenOut,
          pools,
          chainId,
          [...currentPath, pool],
          allPaths,
          startTokenIn,
          maxHops - 1
        );
      }
    }

    return allPaths;
  }

  private buildTrade<TTradeType extends TradeType>(
    tokenInCurrency: Currency,
    tokenOutCurrency: Currency,
    tradeType: TTradeType,
    routeAmount: V2RouteWithValidQuote
  ): Trade<Currency, Currency, TTradeType> {
    const { route, amount, quote } = routeAmount;

    // The route, amount and quote are all in terms of wrapped tokens.
    // When constructing the Trade object the inputAmount/outputAmount must
    // use native currencies if necessary. This is so that the Trade knows to wrap/unwrap.
    if (tradeType == TradeType.EXACT_INPUT) {
      const amountCurrency = CurrencyAmount.fromFractionalAmount(
        tokenInCurrency,
        amount.numerator,
        amount.denominator
      );
      const quoteCurrency = CurrencyAmount.fromFractionalAmount(
        tokenOutCurrency,
        quote.numerator,
        quote.denominator
      );

      const routeCurrency = new Route(
        route.pairs,
        amountCurrency.currency,
        quoteCurrency.currency
      );

      return new Trade({
        v3Routes: [
        ],
        v2Routes: [          {
          routev2: routeCurrency,
          inputAmount: amountCurrency,
          outputAmount: quoteCurrency,
        },],
        tradeType: tradeType,
      });
    } else {
      const quoteCurrency = CurrencyAmount.fromFractionalAmount(
        tokenInCurrency,
        quote.numerator,
        quote.denominator
      );

      const amountCurrency = CurrencyAmount.fromFractionalAmount(
        tokenOutCurrency,
        amount.numerator,
        amount.denominator
      );

      const routeCurrency = new Route(
        route.pairs,
        quoteCurrency.currency,
        amountCurrency.currency
      );

      return new Trade({
        v3Routes: [],
        v2Routes: [
          {
            routev2: routeCurrency,
            inputAmount: quoteCurrency,
            outputAmount: amountCurrency,
          },
        ],
        tradeType: tradeType,
      });
    }
  }

  private buildMethodParameters<TTradeType extends TradeType>(
    trade: Trade<Currency, Currency, TTradeType>,
    swapConfig: SwapOptionsSwapRouter02
  ): MethodParameters {
    const { recipient, slippageTolerance, deadline } = swapConfig;

    const methodParameters = SwapRouter.swapCallParameters(trade, {
      recipient,
      slippageTolerance,
      deadlineOrPreviousBlockhash: deadline,
      // ...(signatureData
      //   ? {
      //       inputTokenPermit:
      //         'allowed' in signatureData
      //           ? {
      //               expiry: signatureData.deadline,
      //               nonce: signatureData.nonce,
      //               s: signatureData.s,
      //               r: signatureData.r,
      //               v: signatureData.v as any,
      //             }
      //           : {
      //               deadline: signatureData.deadline,
      //               amount: signatureData.amount,
      //               s: signatureData.s,
      //               r: signatureData.r,
      //               v: signatureData.v as any,
      //             },
      //     }
      //   : {}),
    });

    return methodParameters;
  }
}
