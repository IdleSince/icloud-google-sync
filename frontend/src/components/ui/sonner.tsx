import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useTheme } from "@/theme/theme-context"

const Toaster = ({ ...props }: ToasterProps) => {
  const { preference } = useTheme()
  const { t } = useTranslation()

  return (
    <Sonner
      theme={preference}
      className="toaster group"
      containerAriaLabel={t("common.notifications")}
      icons={{
        success: <CircleCheckIcon className="size-4 text-success" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4 text-warning" />,
        error: <OctagonXIcon className="size-4 text-danger" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--color-surface-raised)",
          "--normal-text": "var(--color-text-primary)",
          "--normal-border": "var(--color-separator)",
          "--border-radius": "var(--radius-group)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast shadow-popover",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
