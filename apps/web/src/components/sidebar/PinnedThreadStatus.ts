import {
  AlarmClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
} from "lucide-react";
import type { SidebarV2TopStatusKind } from "../Sidebar.logic";

export const PINNED_THREAD_STATUS = {
  working: { icon: CircleDashedIcon, label: "Working", color: "text-info" },
  waiting: { icon: CircleDotDashedIcon, label: "Waiting", color: "text-muted-foreground" },
  approval: {
    icon: ShieldQuestionIcon,
    label: "Approval pending",
    color: "text-warning-foreground",
  },
  input: {
    icon: MessageCircleQuestionIcon,
    label: "Question pending",
    color: "text-indigo-600 dark:text-indigo-300",
  },
  request: { icon: UserRoundIcon, label: "Agent request", color: "text-warning-foreground" },
  limited: { icon: CircleAlertIcon, label: "Usage limited", color: "text-warning" },
  failed: { icon: CircleAlertIcon, label: "Failed", color: "text-error" },
  woke: { icon: AlarmClockIcon, label: "Woke", color: "text-warning" },
  done: { icon: CircleCheckIcon, label: "Unread answer", color: "text-success" },
} satisfies Record<
  SidebarV2TopStatusKind,
  { icon: typeof CircleDashedIcon; label: string; color: string }
>;
