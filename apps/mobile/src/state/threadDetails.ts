import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadStateAtoms,
} from "@t3tools/client-runtime/state/threads";

import { connectionAtomRuntime } from "../connection/runtime";

// Server cost queries need these atoms without importing the thread navigation state.
export const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);
