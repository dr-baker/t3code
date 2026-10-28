import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadStateAtoms,
} from "@t3tools/client-runtime/state/threads";

import { connectionAtomRuntime } from "../connection/runtime";

// Kept apart from ./threads so ./server can read thread details without an import cycle.
export const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);
