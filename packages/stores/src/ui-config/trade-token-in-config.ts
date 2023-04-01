import { AmountConfig, IFeeConfig } from "@keplr-wallet/hooks";
import { ChainGetter, IQueriesStore } from "@keplr-wallet/stores";
import { AppCurrency } from "@keplr-wallet/types";
import {
  CoinPretty,
  Dec,
  DecUtils,
  Int,
  IntPretty,
  RatePretty,
} from "@keplr-wallet/unit";
import {
  NoRouteError,
  NotEnoughLiquidityError,
  OutGivenInRequest,
  Pool,
  Route,
  RouteGenerator,
  SychronousRouteGenerator,
  TokenOutByTokenInResult,
  TokenOutGivenInRouteDelegate,
} from "@osmosis-labs/pools";
import { debounce } from "debounce";
import {
  action,
  autorun,
  computed,
  makeObservable,
  observable,
  override,
  runInAction,
} from "mobx";

import { OsmosisQueries } from "../queries";
import { InsufficientBalanceError, NoSendCurrencyError } from "./errors";
export class ObservableTradeTokenInConfig
  extends AmountConfig
  implements TokenOutGivenInRouteDelegate
{
  // incentives info
  @observable.ref
  protected _pools: Pool[];
  @observable
  protected _incentivizedPoolIds: string[];

  @observable
  protected _sendCurrencyMinDenom: string | undefined = undefined;
  @observable
  protected _outCurrencyMinDenom: string | undefined = undefined;
  @observable
  protected _error: Error | undefined = undefined;

  /** baseDenomIn/baseAmountIn/baseDenomOut => quote result */
  @observable
  protected _tokenInQuotes = new Map<
    string,
    [Route, TokenOutByTokenInResult]
  >();

  /** Quote request corresponding to current coin and amounts. */
  @computed
  get currentQuoteRequest(): OutGivenInRequest | undefined {
    const { amount, denom } = this.getAmountPrimitive();
    if (!amount || new Int(amount).lte(new Int(0))) {
      return undefined;
    }

    return {
      baseDenomIn: denom,
      baseAmountIn: new Int(amount),
      baseDenomOut: this.outCurrency.coinMinimalDenom,
    };
  }

  @computed
  get currentQuotedRoute(): Route | undefined {
    return this.currentQuoteRequest
      ? this._tokenInQuotes.get(serialize(this.currentQuoteRequest))?.[0]
      : undefined;
  }

  /** Quote request for the current configured spot price. */
  @computed
  get currentSpotPriceQuoteRequest(): OutGivenInRequest {
    const one = new Int(
      DecUtils.getTenExponentNInPrecisionRange(this.sendCurrency.coinDecimals)
        .truncate()
        .toString()
    );

    return {
      baseDenomIn: this.sendCurrency.coinMinimalDenom,
      baseAmountIn: one,
      baseDenomOut: this.outCurrency.coinMinimalDenom,
    };
  }

  @computed
  protected get currencyMap(): Map<string, AppCurrency> {
    return this.sendableCurrencies.reduce<Map<string, AppCurrency>>(
      (map, current) => map.set(current.coinMinimalDenom, current),
      new Map()
    );
  }

  @override
  get sendCurrency(): AppCurrency {
    if (this.sendableCurrencies.length === 0) {
      // For the case before pools are initially fetched,

      return this.initialSelectCurrencies.send;
    }

    if (this._sendCurrencyMinDenom) {
      const currency = this.currencyMap.get(this._sendCurrencyMinDenom);
      if (currency) {
        return currency;
      }
    }

    const initialSendCurrency = this.sendableCurrencies.find(
      (c) => c.coinDenom === this.initialSelectCurrencies.send.coinDenom
    );
    const initialCurrency =
      initialSendCurrency &&
      this.sendableCurrencies.find(
        (c) => c.coinDenom === this.initialSelectCurrencies.out.coinDenom
      )
        ? initialSendCurrency
        : undefined;

    return initialCurrency ?? this.sendableCurrencies[0];
  }
  @computed
  get outCurrency(): AppCurrency {
    if (this.sendableCurrencies.length <= 1) {
      // For the case before pools are initially fetched,
      return this.initialSelectCurrencies.out;
    }

    if (this._outCurrencyMinDenom) {
      const currency = this.currencyMap.get(this._outCurrencyMinDenom);
      if (currency) {
        return currency;
      }
    }

    const initialOutCurrency = this.sendableCurrencies.find(
      (c) => c.coinDenom === this.initialSelectCurrencies.out.coinDenom
    );
    const initialCurrency =
      initialOutCurrency &&
      this.sendableCurrencies.find(
        (c) => c.coinDenom === this.initialSelectCurrencies.send.coinDenom
      )
        ? initialOutCurrency
        : undefined;

    return initialCurrency ?? this.sendableCurrencies[1];
  }

  @computed
  get sendableCurrencies(): AppCurrency[] {
    if (this._pools.length === 0) {
      return [];
    }

    const chainInfo = this.chainInfo;

    // Get all coin denom in the pools.
    const coinDenomSet = new Set<string>();
    for (const pool of this._pools) {
      for (const poolAsset of pool.poolAssets) {
        coinDenomSet.add(poolAsset.denom);
      }
    }

    const coinDenoms = Array.from(coinDenomSet);

    const currencyMap = chainInfo.currencies.reduce<Map<string, AppCurrency>>(
      (previous, current) => {
        previous.set(current.coinMinimalDenom, current);
        return previous;
      },
      new Map()
    );

    return coinDenoms
      .filter((coinDenom) => {
        return currencyMap.has(coinDenom);
      })
      .map((coinDenom) => {
        // eslint-disable-next-line
        return currencyMap.get(coinDenom)!;
      });
  }

  /** Take computed primitive values and map to displayable values. */
  @computed
  get expectedSwapResult(): {
    amount: CoinPretty;
    beforeSpotPriceWithoutSwapFeeInOverOut: IntPretty;
    beforeSpotPriceWithoutSwapFeeOutOverIn: IntPretty;
    beforeSpotPriceInOverOut: IntPretty;
    beforeSpotPriceOutOverIn: IntPretty;
    afterSpotPriceInOverOut: IntPretty;
    afterSpotPriceOutOverIn: IntPretty;
    effectivePriceInOverOut: IntPretty;
    effectivePriceOutOverIn: IntPretty;
    tokenInFeeAmount: CoinPretty;
    swapFee: RatePretty;
    priceImpact: RatePretty;
    isMultihopOsmoFeeDiscount: boolean;
  } {
    this.setError(undefined);
    const zero = {
      amount: new CoinPretty(this.outCurrency, new Dec(0)).ready(false),
      beforeSpotPriceWithoutSwapFeeInOverOut: new IntPretty(0).ready(false),
      beforeSpotPriceWithoutSwapFeeOutOverIn: new IntPretty(0),
      beforeSpotPriceInOverOut: new IntPretty(0).ready(false),
      beforeSpotPriceOutOverIn: new IntPretty(0).ready(false),
      afterSpotPriceInOverOut: new IntPretty(0).ready(false),
      afterSpotPriceOutOverIn: new IntPretty(0).ready(false),
      effectivePriceInOverOut: new IntPretty(0).ready(false),
      effectivePriceOutOverIn: new IntPretty(0).ready(false),
      tokenInFeeAmount: new CoinPretty(this.sendCurrency, new Dec(0)).ready(
        false
      ),
      swapFee: new RatePretty(0).ready(false),
      priceImpact: new RatePretty(0).ready(false),
      isMultihopOsmoFeeDiscount: false,
    };
    const request = this.currentQuoteRequest;

    if (this.amount === "" || this.amount === "0" || !request) {
      return zero;
    }

    const multiplicationInOverOut = DecUtils.getTenExponentN(
      this.outCurrency.coinDecimals - this.sendCurrency.coinDecimals
    );
    /** Result for current send currency with latest amount. */
    const result = this._tokenInQuotes.get(serialize(request))?.[1];

    if (!result) return zero;
    if (!result.amount.gt(new Int(0))) {
      this.setError(new Error("Not enough liquidity"));
      return zero;
    }

    // convert to price pretty objects, with proper decimals

    const beforeSpotPriceWithoutSwapFeeInOverOutDec =
      result.beforeSpotPriceInOverOut.mulTruncate(
        new Dec(1).sub(result.swapFee)
      );

    return {
      amount: new CoinPretty(this.outCurrency, result.amount).locale(false),
      beforeSpotPriceWithoutSwapFeeInOverOut: new IntPretty(
        beforeSpotPriceWithoutSwapFeeInOverOutDec.mulTruncate(
          multiplicationInOverOut
        )
      ),
      beforeSpotPriceWithoutSwapFeeOutOverIn:
        beforeSpotPriceWithoutSwapFeeInOverOutDec.gt(new Dec(0)) &&
        multiplicationInOverOut.gt(new Dec(0))
          ? new IntPretty(
              new Dec(1)
                .quoTruncate(beforeSpotPriceWithoutSwapFeeInOverOutDec)
                .quoTruncate(multiplicationInOverOut)
            )
          : new IntPretty(0),
      beforeSpotPriceInOverOut: new IntPretty(
        result.beforeSpotPriceInOverOut.mulTruncate(multiplicationInOverOut)
      ),
      beforeSpotPriceOutOverIn: multiplicationInOverOut.gt(new Dec(0))
        ? new IntPretty(
            result.beforeSpotPriceOutOverIn.quoTruncate(multiplicationInOverOut)
          )
        : new IntPretty(0),
      afterSpotPriceInOverOut: new IntPretty(
        result.afterSpotPriceInOverOut.mulTruncate(multiplicationInOverOut)
      ),
      afterSpotPriceOutOverIn: multiplicationInOverOut.gt(new Dec(0))
        ? new IntPretty(
            result.afterSpotPriceOutOverIn.quoTruncate(multiplicationInOverOut)
          )
        : new IntPretty(0),
      effectivePriceInOverOut: new IntPretty(
        result.effectivePriceInOverOut.mulTruncate(multiplicationInOverOut)
      ),
      effectivePriceOutOverIn: multiplicationInOverOut.gt(new Dec(0))
        ? new IntPretty(
            result.effectivePriceOutOverIn.quoTruncate(multiplicationInOverOut)
          )
        : new IntPretty(0),
      tokenInFeeAmount: new CoinPretty(
        this.sendCurrency,
        result.tokenInFeeAmount
      ).locale(false),
      swapFee: new RatePretty(result.swapFee),
      priceImpact: new RatePretty(result.priceImpact),
      isMultihopOsmoFeeDiscount: result.multiHopOsmoDiscount,
    };
  }

  /** Calculated spot price with amount of 1 token in. */
  @computed
  get beforeSpotPriceWithoutSwapFeeOutOverIn(): IntPretty {
    const result = this._tokenInQuotes.get(
      serialize(this.currentSpotPriceQuoteRequest)
    )?.[1];
    if (!result) return new IntPretty(0).ready(false);

    const multiplicationInOverOut = DecUtils.getTenExponentN(
      this.outCurrency.coinDecimals - this.sendCurrency.coinDecimals
    );
    const beforeSpotPriceWithoutSwapFeeInOverOutDec =
      result.beforeSpotPriceInOverOut.mulTruncate(
        new Dec(1).sub(result.swapFee)
      );

    // low price vs in asset
    if (
      beforeSpotPriceWithoutSwapFeeInOverOutDec.isZero() ||
      multiplicationInOverOut.isZero()
    ) {
      return new IntPretty(0).ready(false);
    }

    return new IntPretty(
      new Dec(1)
        .quoTruncate(beforeSpotPriceWithoutSwapFeeInOverOutDec)
        .quoTruncate(multiplicationInOverOut)
    );
  }

  @override
  get error(): Error | undefined {
    const sendCurrency = this.sendCurrency;
    if (!sendCurrency) {
      return new NoSendCurrencyError("Currency to send not set");
    }

    if (this.amount) {
      if (this._error instanceof NoRouteError) return this._error;

      // check for this before querying amounts
      if (this._error instanceof NotEnoughLiquidityError)
        return new NotEnoughLiquidityError();

      const dec = new Dec(this.amount);
      const balance = this.queriesStore
        .get(this.chainId)
        .queryBalances.getQueryBech32Address(this.sender)
        .getBalanceFromCurrency(this.sendCurrency);
      const balanceDec = balance.toDec();
      if (dec.gt(balanceDec)) {
        return new InsufficientBalanceError("Insufficient balance");
      }
    }

    return this._error;
  }

  constructor(
    chainGetter: ChainGetter,
    protected readonly queriesStore: IQueriesStore<OsmosisQueries>,
    protected readonly initialChainId: string,
    sender: string,
    feeConfig: IFeeConfig | undefined,
    pools: Pool[],
    incentivizedPoolIds: string[] = [],
    protected readonly initialSelectCurrencies: {
      send: AppCurrency;
      out: AppCurrency;
    },
    protected readonly routeGenerator: RouteGenerator = new SychronousRouteGenerator()
  ) {
    super(chainGetter, queriesStore, initialChainId, sender, feeConfig);

    this._pools = pools;
    this._incentivizedPoolIds = incentivizedPoolIds;

    // receive new quotes from route generator
    this.routeGenerator.setTokenInDelegate(this);

    /** Avoid sending too many requests */
    const debounceRequestQuotes = debounce(
      (request: OutGivenInRequest) => {
        this.routeGenerator.requestTokenOutByTokenIn(request);
      },
      1000, // every second, request an amount,
      true // trigger in beginning of interval
    );
    // react to base config changes
    autorun(() => {
      if (this.currentQuoteRequest) {
        debounceRequestQuotes(this.currentQuoteRequest);
      }
    });

    // reset to any changes to in or out currencies
    autorun(() => {
      if (this._sendCurrencyMinDenom || this._outCurrencyMinDenom) {
        // reset maps
        this.setError(undefined);
        runInAction(() => {
          this._tokenInQuotes = new Map();
        });

        // request spot price
        this.routeGenerator.requestTokenOutByTokenIn(
          this.currentSpotPriceQuoteRequest
        );
      }
    });

    // react to any changes to incentives info, pass to route generator
    autorun(() => {
      /** likely uosmo */
      const stakeCurrencyMinDenom = this.chainGetter.getChain(
        this.initialChainId
      ).stakeCurrency.coinMinimalDenom;

      this.routeGenerator.updateIncentivesInfo(
        this._incentivizedPoolIds,
        stakeCurrencyMinDenom
      );
    });

    makeObservable(this);
  }

  @action
  receiveQuote(
    request: OutGivenInRequest,
    route: Route,
    result: TokenOutByTokenInResult
  ): void {
    const key = serialize(request);
    this._tokenInQuotes.set(key, [route, result]);
  }
  @action
  receiveError(
    request: OutGivenInRequest,
    error: Error | NotEnoughLiquidityError
  ): void {
    this._tokenInQuotes.delete(serialize(request));
    this.setError(error);
  }

  @action
  setPools(pools: Pool[]) {
    this._pools = pools;
    this.routeGenerator.updatePools(pools);
  }

  @action
  setIncentivizedPoolIds(poolIds: string[]) {
    this._incentivizedPoolIds = poolIds;
  }

  @override
  setSendCurrency(currency: AppCurrency | undefined) {
    if (currency) {
      this._sendCurrencyMinDenom = currency.coinMinimalDenom;
    } else {
      this._sendCurrencyMinDenom = undefined;
    }
  }

  @action
  setOutCurrency(currency: AppCurrency | undefined) {
    if (currency) {
      this._outCurrencyMinDenom = currency.coinMinimalDenom;
    } else {
      this._outCurrencyMinDenom = undefined;
    }
  }

  @action
  switchInAndOut() {
    // give back the swap fee amount
    const outAmount = this.expectedSwapResult.amount;
    if (outAmount.toDec().isZero()) {
      this.setAmount("");
    } else {
      this.setAmount(
        outAmount
          .shrink(true)
          .maxDecimals(6)
          .trim(true)
          .hideDenom(true)
          .toString()
      );
    }

    // Since changing in and out affects each other, it is important to use the stored value.
    const prevInCurrency = this.sendCurrency.coinMinimalDenom;
    const prevOutCurrency = this.outCurrency.coinMinimalDenom;

    this._sendCurrencyMinDenom = prevOutCurrency;
    this._outCurrencyMinDenom = prevInCurrency;
  }

  @action
  setError(error: Error | undefined) {
    this._error = error;
  }
}

/** Used for generating keys that can organize responses as they arrive. */
function serialize({
  baseDenomIn,
  baseAmountIn,
  baseDenomOut,
}: OutGivenInRequest) {
  return `${baseDenomIn}/${baseAmountIn.toString()}/${baseDenomOut}`;
}
