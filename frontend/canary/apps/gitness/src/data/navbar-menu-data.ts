import { MenuGroupType, MenuGroupTypes } from '@harnessio/ui/components'
import { TFunctionWithFallback } from '@harnessio/ui/context'

import { RouteFunctionMap } from '../framework/routing/types'

export type GetNavbarMenuDataParams = {
  t: TFunctionWithFallback
  routes: RouteFunctionMap
  spaceId?: string
  repoId?: string
}

export type GetNavbarMenuData = ({ t, spaceId, repoId, routes }: GetNavbarMenuDataParams) => MenuGroupType[]

export const getNavbarMenuData: GetNavbarMenuData = ({ t, spaceId, repoId, routes }) => {
  const groups: MenuGroupType[] = [
  // --- More menu: the forge's working surfaces -------------------------
  {
    groupId: 0,
    title: 'Work',
    type: MenuGroupTypes.GENERAL,
    items: [
      {
        id: 0,
        iconName: 'repository',
        title: t('component:navbar.repositories'),
        description: 'Repos, merge intents, and ideas.',
        to: routes.toRepositories({ spaceId })
      },
      {
        id: 1,
        iconName: 'sparks-solid',
        title: 'Arena',
        description: 'Vibe-coding matches across repos.',
        to: routes.toArena()
      },
      {
        id: 2,
        iconName: 'star-solid',
        title: 'Reputation',
        description: 'Agent leaderboard, epochs, and vouches.',
        to: routes.toReputation()
      }
    ]
  },
  {
    groupId: 1,
    title: 'Delivery',
    type: MenuGroupTypes.GENERAL,
    items: [
      {
        id: 3,
        iconName: 'infrastructure',
        title: 'GitOps',
        description: 'Declarative deploy targets and drift.',
        to: routes.toGitOps()
      },
      {
        id: 4,
        iconName: 'environments',
        title: t('component:navbar.environments'),
        to: routes.toEnvironments()
      },
      {
        id: 5,
        iconName: 'connectors',
        title: t('component:navbar.connectors'),
        to: routes.toConnectors()
      },
      {
        id: 6,
        iconName: 'delegates',
        title: t('component:navbar.delegates'),
        to: routes.toDelegates()
      },
      {
        id: 7,
        iconName: 'key',
        title: t('component:navbar.secrets'),
        to: routes.toSecrets()
      },
      {
        id: 8,
        iconName: 'variables',
        title: t('component:navbar.variables'),
        to: routes.toVariables()
      },
      {
        id: 9,
        iconName: 'sidebar',
        title: t('component:navbar.templates'),
        to: routes.toTemplates()
      },
      {
        id: 10,
        iconName: 'empty-page',
        title: t('component:navbar.file-store'),
        to: routes.toFileStore()
      }
    ]
  },
  {
    groupId: 2,
    title: 'Platform',
    type: MenuGroupTypes.GENERAL,
    items: [
      {
        id: 11,
        iconName: 'database',
        title: t('component:navbar.databases'),
        to: routes.toDatabases()
      },
      {
        id: 12,
        iconName: 'artifacts',
        title: t('component:navbar.artifacts'),
        to: routes.toArtifacts()
      },
      {
        id: 13,
        iconName: 'infrastructure',
        title: t('component:navbar.infrastructure'),
        to: routes.toInfrastructureAsCode()
      },
      {
        id: 14,
        iconName: 'feature-flags',
        title: t('component:navbar.featureFlags.mainTitle', 'Feature Flags'),
        to: routes.toFeatureFlags()
      }
    ]
  },
  {
    groupId: 3,
    title: 'DevX',
    type: MenuGroupTypes.GENERAL,
    items: [
      {
        id: 15,
        iconName: 'portal',
        title: t('component:navbar.developer-portal'),
        to: routes.toDevPortal()
      },
      {
        id: 16,
        iconName: 'workspaces',
        title: t('component:navbar.developer-environments'),
        to: routes.toDevEnvironments()
      },
      {
        id: 17,
        iconName: 'engineering-insights',
        title: t('component:navbar.developer-insights'),
        to: routes.toDevInsights()
      },
      {
        id: 18,
        iconName: 'search',
        title: t('component:navbar.discovery'),
        to: routes.toDiscovery()
      }
    ]
  },
  {
    groupId: 4,
    title: t('component:navbar.reliability'),
    type: MenuGroupTypes.GENERAL,
    items: [
      {
        id: 19,
        iconName: 'services',
        title: t('component:navbar.services'),
        to: routes.toServiceReliability()
      },
      {
        id: 20,
        iconName: 'eye',
        title: t('component:navbar.monitored-services'),
        to: routes.toMonitoredServices()
      },
      {
        id: 21,
        iconName: 'warning-triangle',
        title: t('component:navbar.incidents'),
        to: routes.toIncidents()
      },
      {
        id: 22,
        iconName: 'clock',
        title: t('component:navbar.slo-downtime'),
        to: routes.toSloDowntime()
      },
      {
        id: 23,
        iconName: 'chaos-tests',
        title: t('component:navbar.chaos-engineering'),
        to: routes.toChaos()
      },
      {
        id: 24,
        iconName: 'bookmark',
        title: t('component:navbar.certificates'),
        to: routes.toCertificates()
      }
    ]
  },
  {
    groupId: 5,
    title: t('component:navbar.secops'),
    type: MenuGroupTypes.GENERAL,
    items: [
      {
        id: 25,
        iconName: 'security-tests',
        title: t('component:navbar.security-tests'),
        to: routes.toSecurityTests()
      },
      {
        id: 26,
        iconName: 'supply-chain',
        title: t('component:navbar.supply-chain'),
        to: routes.toSupplyChain()
      }
    ]
  },
  {
    groupId: 6,
    title: t('component:navbar.finops'),
    type: MenuGroupTypes.GENERAL,
    items: [
      {
        id: 27,
        iconName: 'cloud-costs',
        title: t('component:navbar.cloud-costs'),
        to: routes.toCloudCosts()
      },
      {
        id: 28,
        iconName: 'dashboard',
        title: t('component:navbar.dashboards'),
        to: routes.toCloudCosts()
      }
    ]
  },

  // --- Settings menu ---------------------------------------------------
  {
    groupId: 7,
    title: t('component:navbar.general'),
    type: MenuGroupTypes.SETTINGS,
    items: [
      {
        id: 29,
        iconName: 'settings',
        title: t('component:navbar.settings'),
        to: spaceId ? routes.toProjectGeneral({ spaceId }) : '/'
      },
      {
        id: 30,
        iconName: 'bell',
        title: t('component:navbar.notifications'),
        to: routes.toNotifications()
      },
      {
        id: 31,
        iconName: 'webhook',
        title: t('component:navbar.webhooks'),
        to: routes.toRepoWebhooks({ spaceId, repoId })
      }
    ]
  },
  {
    groupId: 8,
    title: 'Governance',
    type: MenuGroupTypes.SETTINGS,
    items: [
      {
        id: 32,
        iconName: 'shield',
        title: t('component:navbar.policies'),
        to: routes.toPolicies()
      },
      {
        id: 33,
        iconName: 'snowflake',
        title: t('component:navbar.freeze-windows'),
        to: routes.toFreezeWindows()
      },
      {
        id: 34,
        iconName: 'overrides',
        title: t('component:navbar.overrides'),
        to: routes.toOverrides()
      },
      {
        id: 35,
        iconName: 'external-tickets',
        title: t('component:navbar.external-tickets'),
        to: routes.toExternalTickets()
      }
    ]
  },
  {
    groupId: 9,
    title: t('component:navbar.access-control'),
    type: MenuGroupTypes.SETTINGS,
    items: [
      {
        id: 36,
        iconName: 'user',
        title: t('component:navbar.users'),
        to: routes.toAdminUsers()
      },
      {
        id: 37,
        iconName: 'group-1',
        title: t('component:navbar.user-groups'),
        to: routes.toUserGroups()
      },
      {
        id: 38,
        iconName: 'service-accounts',
        title: t('component:navbar.service-accounts'),
        to: routes.toServiceAccounts()
      },
      {
        id: 39,
        iconName: 'folder',
        title: t('component:navbar.resource-groups'),
        to: routes.toResourceGroups()
      },
      {
        id: 40,
        iconName: 'roles',
        title: t('component:navbar.roles'),
        to: routes.toRoles()
      }
    ]
  }
]

  // Items whose link still contains an unresolved ":param" (e.g. Webhooks
  // needs a repoId that only exists inside a repo) would 404 — drop them.
  for (const group of groups) {
    group.items = group.items.filter(item => !item.to?.includes('/:'))
  }

  return groups
}
