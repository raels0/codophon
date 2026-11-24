import { DEFAULT_NAME } from './constants.ts';
import { formatGreeting } from './greeting.ts';

export const greeting = formatGreeting('Codophon');
export const defaultGreeting = formatGreeting(DEFAULT_NAME);
