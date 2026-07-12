import { LoadingLogo } from "./LoadingLogo"
import { CONSOLE_NAME } from "../brand"

type Variant = "fullscreen" | "content"

export function LoadingScreen(props: { variant: Variant }) {
  return (
    <section
      class="console-loading"
      classList={{
        "console-loading-fullscreen": props.variant === "fullscreen",
        "console-loading-content": props.variant === "content",
      }}
      role="status"
      aria-live="polite"
      aria-label={`Loading ${CONSOLE_NAME}`}
    >
      <LoadingLogo />
    </section>
  )
}
