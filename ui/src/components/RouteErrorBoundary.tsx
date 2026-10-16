/**
 * The last line of defence for a route: one component whose render throws used
 * to blank the whole page (a `TypeError` in the draft editor left a white
 * screen and nothing but a console line). Catching at the top of `<main>`
 * keeps the app bar, the footer and a readable problem in place, and offers
 * the one action that is always honest from a broken render — reload.
 *
 * Class component: catching a render error (`getDerivedStateFromError`) is
 * only available on classes.
 * `Shell` keys it by `location.pathname`, so navigating to another route mounts
 * a fresh boundary and a stale crash does not follow the user around.
 */
import { Component, type ReactNode } from "react";
import { Alert } from "./ds/Alert";
import { Button } from "./ds/Button";

export interface RouteErrorBoundaryProps {
  children: ReactNode;
  /** Overridable so a test can prove the button is wired without navigating. */
  onReload?: () => void;
}

interface State {
  error: Error | null;
}

export class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  // React already logs a caught error and its component stack; there is no
  // collector to send it to (`02`: no client telemetry), so no componentDidCatch.
  private readonly reload = () => {
    const { onReload } = this.props;
    if (onReload) onReload();
    else window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Alert
        state="failed"
        label="FAILED"
        role="alert"
        testid="route-error-boundary"
        action={
          <Button compact onClick={this.reload} data-testid="route-error-reload">
            Reload
          </Button>
        }
      >
        <p className="font-mono text-[11.5px]">
          This page failed to render. The rest of the app is still here.
        </p>
        <p className="font-mono text-[10.5px] text-faint">{error.message}</p>
      </Alert>
    );
  }
}

export default RouteErrorBoundary;
