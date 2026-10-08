import KScanApp from '../../app';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import { getActorContext } from '../../services/actorContext';

export default function ScannerRoute() {
  // AuthGate retains the navigator during recovery/account transitions. Key
  // Scanner's local session to the actual actor epoch so completed photos and
  // results are removed even when this route remains mounted across A -> B.
  useAuthSession();
  const actor = getActorContext();
  return <KScanApp key={`${actor.actorId ?? 'device-local'}:${actor.epoch}`} />;
}
