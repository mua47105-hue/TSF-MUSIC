// Web mock for expo-network (v5.0.2 FIX 2 — house rule 15 parity).
// On web, expo-network uses navigator.onLine, which is non-deterministic
// for tests. This mock provides deterministic behavior for the web lab.

export type NetworkStateType =
  | 'unknown'
  | 'none'
  | 'cellular'
  | 'wifi'
  | 'bluetooth'
  | 'ethernet'
  | 'wimax'
  | 'vpn'
  | 'other';

export interface NetworkState {
  type: NetworkStateType;
  isConnected: boolean;
  isInternetReachable: boolean;
}

let mockState: NetworkState = {
  type: 'unknown',
  isConnected: false,
  isInternetReachable: false,
};

export async function getNetworkStateAsync(): Promise<NetworkState> {
  return mockState;
}

// Test seam: allows tests to set the mock state
export function __setMockNetworkState(state: NetworkState): void {
  mockState = state;
}

// Test seam: reset to unknown
export function __resetMockNetworkState(): void {
  mockState = {
    type: 'unknown',
    isConnected: false,
    isInternetReachable: false,
  };
}
