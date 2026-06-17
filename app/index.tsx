import { HOME_NAVIGATION_V2_ENABLED } from '../constants/featureFlags';
import { HomeLegacy } from '../components/home';
import { HomeV2 } from '../components/home';

export default function Home() {
  if (HOME_NAVIGATION_V2_ENABLED) {
    return <HomeV2 />;
  }
  return <HomeLegacy />;
}
