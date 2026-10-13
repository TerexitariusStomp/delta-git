import { Layout } from '@/components'
import { useRouterContext } from '@/context'

import AvatarDropdown from './avatar-dropdown'
import ScopeSelector from './scope-selector'

export default function Header() {
  const { Link } = useRouterContext()

  return (
    <Layout.Flex className="bg-cn-0 p-cn-header h-cn-header" gap="md" justify="between" align="center">
      <Link to="/">
        <img src="/logo-widespread.png" alt="Widespread" className="size-6" />
      </Link>
      <div className="w-full">
        <ScopeSelector />
      </div>
      <AvatarDropdown />
    </Layout.Flex>
  )
}
