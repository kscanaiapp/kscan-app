import { HOME_NAVIGATION_V2_ENABLED, ACCOUNT_HOME_UX_V1_ENABLED } from '../constants/featureFlags';
import { HomeLegacy, HomeV2, HomeLuxuryTechV1 } from '../components/home';

export default function Home() {
  if (HOME_NAVIGATION_V2_ENABLED && ACCOUNT_HOME_UX_V1_ENABLED) {
    return <HomeLuxuryTechV1 />;
  }
  if (HOME_NAVIGATION_V2_ENABLED) {
    return <HomeV2 />;
  }
  return <HomeLegacy />;
}
