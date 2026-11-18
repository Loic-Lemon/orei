// jsdom has no layout engine. Native runner verifies real ResizeObserver behavior.
globalThis.ResizeObserver ??= class { observe(){} unobserve(){} disconnect(){} };

import {configure} from '@testing-library/react';
configure({asyncUtilTimeout:10000});

import {afterEach} from 'vitest';
afterEach(()=>localStorage.clear());
