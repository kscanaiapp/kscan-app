/** Registers the containment stub loader. Used as `node --import <this>`. */
import { register } from 'node:module';

register('./posthogContainmentLoader.mjs', import.meta.url);
