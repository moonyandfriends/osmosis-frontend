import { Int } from "@keplr-wallet/unit";

import { Pool } from "..";
import { NotEnoughLiquidityError } from "./errors";
import { Route, TokenOutByTokenInResult } from "./routes";

export type OutGivenInRequest = {
  baseDenomIn: string;
  baseAmountIn: Int;
  baseDenomOut: string;
};

/** Object that can accept routes from the route generator. */
export interface TokenOutGivenInRouteDelegate {
  receiveQuote(
    request: OutGivenInRequest,
    route: Route,
    result: TokenOutByTokenInResult
  ): void;
  receiveError(
    request: OutGivenInRequest,
    error: Error | NotEnoughLiquidityError
  ): void;
}

/** Generates quotes given requests. The generator+delegate pattern
 *  offers flexibility in how the quotes are generated. For example,
 *  the generator could be synchronous or asynchronous, and the delegate(s)
 *  could be a single object or multiple objects.
 */
export interface RouteGenerator {
  /** Set object generator sends new routes to. */
  setTokenInDelegate(delegate: TokenOutGivenInRouteDelegate): void;
  // TODO: add token in given out delegate
  /** Update pools used for routing. */
  updatePools(pools: Pool[]): void;
  /** Update pools determined to be incentivized and incentive denom. */
  updateIncentivesInfo(poolIds: string[], incentiveBaseDenom: string): void;
  /** Async request route given an in amount, to be received by delegate. */
  requestTokenOutByTokenIn(request: OutGivenInRequest): void;
  // TODO: add token in given out request
}
