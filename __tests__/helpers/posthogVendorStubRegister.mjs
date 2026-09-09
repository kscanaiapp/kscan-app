/** Registers the vendor-stub loader hooks. Used as `node --import <this>`. */
import { register } from 'node:module';

register('./posthogVendorStubLoader.mjs', import.meta.url);
