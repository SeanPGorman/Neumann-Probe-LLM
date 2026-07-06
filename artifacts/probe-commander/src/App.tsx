import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Component, type ReactNode } from "react";
import Commander from "@/pages/Commander";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div style={{ padding: "2rem", fontFamily: "monospace", color: "#f87171", background: "#0a0a0a", minHeight: "100vh" }}>
          <div style={{ fontSize: "0.75rem", letterSpacing: "0.1em", marginBottom: "1rem", color: "#6b7280" }}>RUNTIME ERROR</div>
          <div style={{ marginBottom: "0.5rem" }}>{(error as Error).message}</div>
          <pre style={{ fontSize: "0.65rem", color: "#4b5563", whiteSpace: "pre-wrap" }}>{(error as Error).stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Commander} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
