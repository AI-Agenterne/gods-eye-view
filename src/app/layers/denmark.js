import { createDenmarkLayer } from '../../layers/denmark/index.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Construct the Denmark pack layer using the application scene owners. */
export function createApplicationDenmark({ source }) {
  return createDenmarkLayer({
    source,
    services: { render, context, picking, isPointerFree },
  });
}
