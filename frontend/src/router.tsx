import { useEffect, useState, type AnchorHTMLAttributes } from 'react'

// Each view has its own address, so a tab can be bookmarked, shared, or opened
// in a second window. There is no router library: four static paths and a
// history listener are the whole of it.
export type Route = 'home' | 'convert' | 'analysis' | 'settings'

const ROUTES: Route[] = ['home', 'convert', 'analysis', 'settings']

export const pathOf = (route: Route) => `/${route}`

function routeOf(pathname: string): Route {
  const seg = pathname.replace(/^\/+|\/+$/g, '')
  return ROUTES.includes(seg as Route) ? (seg as Route) : 'home'
}

// pushState does not fire popstate, so a navigation has to tell the hooks itself.
const listeners = new Set<() => void>()

export function navigate(to: Route) {
  if (window.location.pathname !== pathOf(to)) {
    window.history.pushState(null, '', pathOf(to))
  }
  listeners.forEach((notify) => notify())
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => routeOf(window.location.pathname))

  useEffect(() => {
    const sync = () => {
      const next = routeOf(window.location.pathname)
      // An unrecognised path -- "/" included -- lands on Home, so rewrite the
      // address bar to the link that actually reproduces what is on screen.
      if (window.location.pathname !== pathOf(next)) {
        window.history.replaceState(null, '', pathOf(next))
      }
      setRoute(next)
    }
    sync()
    listeners.add(sync)
    window.addEventListener('popstate', sync)
    return () => {
      listeners.delete(sync)
      window.removeEventListener('popstate', sync)
    }
  }, [])

  return route
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'> & {
  to: Route
}

export function RouteLink({ to, ...rest }: LinkProps) {
  return (
    <a
      {...rest}
      href={pathOf(to)}
      onClick={(e) => {
        // Modified and non-primary clicks stay the browser's: "open in new tab"
        // has to keep working on something shaped like a link.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
        e.preventDefault()
        navigate(to)
      }}
    />
  )
}
