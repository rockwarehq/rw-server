'use client'

import clsx from 'clsx'
import { AnimatePresence, motion, useIsPresent } from 'framer-motion'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useRef } from 'react'

import { useIsInsideMobileNavigation } from '@/components/MobileNavigation'
import { useSectionStore } from '@/components/SectionProvider'
import { Tag } from '@/components/Tag'
import { remToPx } from '@/lib/remToPx'
import { CloseButton } from '@headlessui/react'

interface NavGroup {
  title: string
  links: Array<{
    title: string
    href: string
  }>
}

function useInitialValue<T>(value: T, condition = true) {
  // eslint-disable-next-line react-hooks/refs
  let initialValue = useRef(value).current
  return condition ? initialValue : value
}

function TopLevelNavItem({
  href,
  children,
}: {
  href: string
  children: React.ReactNode
}) {
  return (
    <li className="md:hidden">
      <CloseButton
        as={Link}
        href={href}
        className="block py-1 text-sm text-zinc-600 transition hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
      >
        {children}
      </CloseButton>
    </li>
  )
}

function NavLink({
  href,
  children,
  tag,
  active = false,
  isAnchorLink = false,
}: {
  href: string
  children: React.ReactNode
  tag?: string
  active?: boolean
  isAnchorLink?: boolean
}) {
  return (
    <CloseButton
      as={Link}
      href={href}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'flex justify-between gap-2 py-1 pr-3 text-sm transition',
        isAnchorLink ? 'pl-7' : 'pl-4',
        active
          ? 'text-zinc-900 dark:text-white'
          : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white',
      )}
    >
      <span className="truncate">{children}</span>
      {tag && (
        <Tag variant="small" color="zinc">
          {tag}
        </Tag>
      )}
    </CloseButton>
  )
}

function VisibleSectionHighlight({
  group,
  pathname,
}: {
  group: NavGroup
  pathname: string
}) {
  let [sections, visibleSections] = useInitialValue(
    [
      useSectionStore((s) => s.sections),
      useSectionStore((s) => s.visibleSections),
    ],
    useIsInsideMobileNavigation(),
  )

  let isPresent = useIsPresent()
  let firstVisibleSectionIndex = Math.max(
    0,
    [{ id: '_top' }, ...sections].findIndex(
      (section) => section.id === visibleSections[0],
    ),
  )
  let itemHeight = remToPx(2)
  let height = isPresent
    ? Math.max(1, visibleSections.length) * itemHeight
    : itemHeight
  let top =
    group.links.findIndex((link) => link.href === pathname) * itemHeight +
    firstVisibleSectionIndex * itemHeight

  return (
    <motion.div
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { delay: 0.2 } }}
      exit={{ opacity: 0 }}
      className="absolute inset-x-0 top-0 bg-zinc-800/2.5 will-change-transform dark:bg-white/2.5"
      style={{ borderRadius: 8, height, top }}
    />
  )
}

function ActivePageMarker({
  group,
  pathname,
}: {
  group: NavGroup
  pathname: string
}) {
  let itemHeight = remToPx(2)
  let offset = remToPx(0.25)
  let activePageIndex = group.links.findIndex((link) => link.href === pathname)
  let top = offset + activePageIndex * itemHeight

  return (
    <motion.div
      layout
      className="absolute left-2 h-6 w-px bg-emerald-500"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { delay: 0.2 } }}
      exit={{ opacity: 0 }}
      style={{ top }}
    />
  )
}

function NavigationGroup({
  group,
  className,
}: {
  group: NavGroup
  className?: string
}) {
  // If this is the mobile navigation then we always render the initial
  // state, so that the state does not change during the close animation.
  // The state will still update when we re-open (re-render) the navigation.
  let isInsideMobileNavigation = useIsInsideMobileNavigation()
  let [pathname, sections] = useInitialValue(
    [usePathname(), useSectionStore((s) => s.sections)],
    isInsideMobileNavigation,
  )

  let isActiveGroup =
    group.links.findIndex((link) => link.href === pathname) !== -1

  return (
    <li className={clsx('relative mt-6', className)}>
      <motion.h2
        layout="position"
        className="text-xs font-semibold text-zinc-900 dark:text-white"
      >
        {group.title}
      </motion.h2>
      <div className="relative mt-3 pl-2">
        <AnimatePresence initial={!isInsideMobileNavigation}>
          {isActiveGroup && (
            <VisibleSectionHighlight group={group} pathname={pathname} />
          )}
        </AnimatePresence>
        <motion.div
          layout
          className="absolute inset-y-0 left-2 w-px bg-zinc-900/10 dark:bg-white/5"
        />
        <AnimatePresence initial={false}>
          {isActiveGroup && (
            <ActivePageMarker group={group} pathname={pathname} />
          )}
        </AnimatePresence>
        <ul role="list" className="border-l border-transparent">
          {group.links.map((link) => (
            <motion.li key={link.href} layout="position" className="relative">
              <NavLink href={link.href} active={link.href === pathname}>
                {link.title}
              </NavLink>
              <AnimatePresence mode="popLayout" initial={false}>
                {link.href === pathname && sections.length > 0 && (
                  <motion.ul
                    role="list"
                    initial={{ opacity: 0 }}
                    animate={{
                      opacity: 1,
                      transition: { delay: 0.1 },
                    }}
                    exit={{
                      opacity: 0,
                      transition: { duration: 0.15 },
                    }}
                  >
                    {sections.map((section) => (
                      <li key={section.id}>
                        <NavLink
                          href={`${link.href}#${section.id}`}
                          tag={section.tag}
                          isAnchorLink
                        >
                          {section.title}
                        </NavLink>
                      </li>
                    ))}
                  </motion.ul>
                )}
              </AnimatePresence>
            </motion.li>
          ))}
        </ul>
      </div>
    </li>
  )
}

export const publicNavigation: Array<NavGroup> = [
  {
    title: 'Documentation',
    links: [
      { title: 'Introduction', href: '/' },
      { title: 'Getting Started', href: '/getting-started' },
    ],
  },
]

export const internalNavigation: Array<NavGroup> = [
  {
    title: 'Internal',
    links: [{ title: 'Overview', href: '/internal' }],
  },
  {
    title: 'Guides',
    links: [
      { title: 'Local Development', href: '/internal/guides/local-development' },
    ],
  },
  {
    title: 'Architecture',
    links: [
      { title: 'System Overview', href: '/internal/architecture' },
      { title: 'API Server', href: '/internal/architecture/api' },
      { title: 'Auth & IAM', href: '/internal/architecture/auth' },
      { title: 'Edge & Data Pipeline', href: '/internal/architecture/edge' },
      { title: 'Background Work', href: '/internal/architecture/workers' },
      { title: 'Livestore', href: '/internal/architecture/livestore' },
      { title: 'Data Model & Metrics', href: '/internal/architecture/data-model' },
    ],
  },
  {
    title: 'ADRs',
    links: [
      { title: 'ADR Log', href: '/internal/adrs' },
      { title: 'Template', href: '/internal/adrs/template' },
      {
        title: '0001 – Record Architecture Decisions',
        href: '/internal/adrs/0001-record-architecture-decisions',
      },
      {
        title: '0002 – Database Access Boundary',
        href: '/internal/adrs/0002-database-access-boundary',
      },
      {
        title: '0003 – Service Error Contract',
        href: '/internal/adrs/0003-service-error-contract',
      },
      {
        title: '0004 – App-Owned Composition Roots',
        href: '/internal/adrs/0004-app-owned-composition-roots',
      },
      {
        title: '0005 – Station Status: Running, Slow, Down',
        href: '/internal/adrs/0005-station-status-running-slow-down',
      },
      {
        title: '0006 – Metric Bucket Fields & OEE',
        href: '/internal/adrs/0006-metric-bucket-field-definitions',
      },
      {
        title: '0007 – MES History Correctness Defaults',
        href: '/internal/adrs/0007-mes-history-correctness-defaults',
      },
    ],
  },
  {
    title: 'Meta',
    links: [{ title: 'How to Write Docs', href: '/internal/contributing' }],
  },
]

// Union of both trees — for lookups that aren't tied to the current route,
// e.g. search-result group titles.
export const allNavigation: Array<NavGroup> = [
  ...publicNavigation,
  ...internalNavigation,
]

export function navigationFor(pathname: string): Array<NavGroup> {
  return pathname === '/internal' || pathname.startsWith('/internal/')
    ? internalNavigation
    : publicNavigation
}

export function Navigation(props: React.ComponentPropsWithoutRef<'nav'>) {
  let navigation = navigationFor(usePathname())

  return (
    <nav {...props}>
      <ul role="list">
        <TopLevelNavItem href="/">Docs</TopLevelNavItem>
        <TopLevelNavItem href="/internal">Internal</TopLevelNavItem>
        {navigation.map((group, groupIndex) => (
          <NavigationGroup
            key={group.title}
            group={group}
            className={groupIndex === 0 ? 'md:mt-0' : ''}
          />
        ))}
      </ul>
    </nav>
  )
}
