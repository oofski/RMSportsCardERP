import { useSession } from './lib/session'
import { CenterLoader } from './components/ui'
import { SetupScreen } from './screens/SetupScreen'
import { LoginScreen } from './screens/LoginScreen'
import { ChangePasswordScreen } from './screens/ChangePasswordScreen'
import { AppShell } from './screens/AppShell'

export default function App(): JSX.Element {
  const { loading, needsSetup, user } = useSession()

  if (loading) return <CenterLoader />
  if (!user && needsSetup) return <SetupScreen />
  if (!user) return <LoginScreen />
  if (user.mustChangePassword) return <ChangePasswordScreen />
  return <AppShell />
}
