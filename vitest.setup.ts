/**
 * Vitest setup file for agent-vm
 *
 * This file runs before each test file.
 * Use it to set up global mocks, extend expect, etc.
 */

import { beforeAll, afterAll, afterEach } from 'vitest';

// Example: Reset mocks after each test
afterEach(() => {
	// vi.clearAllMocks();
});

// Example: Global setup
beforeAll(() => {
	// Set up test environment
});

// Example: Global teardown
afterAll(() => {
	// Clean up test environment
});
