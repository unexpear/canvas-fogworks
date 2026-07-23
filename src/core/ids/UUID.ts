/**
 * @module UUID
 * @description Document-wide unique identity. Every node id comes from here, so
 * identity is never derived from array position or insertion order.
 */

import { v4 as uuidv4 } from 'uuid';

export function generateUUID(): string {
    return uuidv4();
}
