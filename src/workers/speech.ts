/** Speech engine process entry point. */
import { serve } from './rpc';
import { speechHandlers } from './speechCore';

serve(speechHandlers);
