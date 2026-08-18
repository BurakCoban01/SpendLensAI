import { findPortListeners, printPortGuidance } from "./dev-port-utils.mjs";

const listeners = findPortListeners();
if (listeners.length > 0) {
  printPortGuidance(listeners);
  process.exit(1);
}
printPortGuidance(listeners);
