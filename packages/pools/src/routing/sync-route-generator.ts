import { Pool } from "../interface";
import { NoRouteError } from "./errors";
import {
  OutGivenInRequest,
  RouteGenerator,
  TokenOutGivenInRouteDelegate,
} from "./interface";
import { OptimizedRoutes } from "./routes";

/** Receives quote requests and immediately calculates them for service to delegate(s).
 *
 *  **Does not handle caching.**
 *
 *  Generating routed quotes synchronously is useful for testing and for cases where
 *  the user is not waiting for a quote on the main thread.
 *  They can be expensive to calculate, so this should be used sparingly on the main thread.
 *  If on the main thread, use an asynchronous (web worker or web service) route generator.
 */
export class SychronousRouteGenerator implements RouteGenerator {
  /** Ref to object that receives route results for token out give in swaps. */
  protected _tokenInDelegate: TokenOutGivenInRouteDelegate | undefined;

  protected _router: OptimizedRoutes | undefined;
  protected _incentivizedPoolIds: string[] = [];
  protected _incentiveBaseDenom: string | undefined;

  constructor(
    protected readonly maxPoolsInRoute = 3,
    protected readonly maxRoutesPerRequest = 3
  ) {}

  setTokenInDelegate(delegate: TokenOutGivenInRouteDelegate): void {
    this._tokenInDelegate = delegate;
  }
  updatePools(pools: Pool[]): void {
    if (!this._incentiveBaseDenom) {
      console.warn("incentiveBaseDenom not set, skipping updatePools");
      return;
    }

    this._router = new OptimizedRoutes(
      pools,
      this._incentivizedPoolIds,
      this._incentiveBaseDenom
    );
  }
  updateIncentivesInfo(poolIds: string[], incentiveBaseDenom: string): void {
    this._incentivizedPoolIds = poolIds;
    this._incentiveBaseDenom = incentiveBaseDenom;
  }

  requestTokenOutByTokenIn(request: OutGivenInRequest): void {
    if (!this._tokenInDelegate || !this._router) return;

    const { baseDenomIn, baseAmountIn, baseDenomOut } = request;

    try {
      const routes = this._router.getOptimizedRoutesByTokenIn(
        {
          denom: baseDenomIn,
          amount: baseAmountIn,
        },
        baseDenomOut,
        this.maxPoolsInRoute,
        this.maxRoutesPerRequest
      );

      if (routes.length === 0 && !baseAmountIn.isZero()) {
        throw new NoRouteError();
      }

      const result = this._router.calculateTokenOutByTokenIn(routes);
      this._tokenInDelegate.receiveQuote(request, routes[0], result);
    } catch (e: any) {
      this._tokenInDelegate.receiveError(request, e);
    }
  }
}
