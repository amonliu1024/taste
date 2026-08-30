import { useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";

interface ConfirmPopoverProps {
  trigger: ReactNode;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
}

/** Anchored confirmation for destructive actions; closes only after a successful action. */
export default function ConfirmPopover({ trigger, message, confirmLabel = "确认删除", onConfirm }: ConfirmPopoverProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="confirm-popover" side="top" align="center" sideOffset={8} collisionPadding={8}>
          <p>{message}</p>
          <div className="confirm-actions">
            <Popover.Close className="confirm-cancel">取消</Popover.Close>
            <button className="confirm-danger" disabled={busy} onClick={() => void confirm()}>{busy ? "处理中…" : confirmLabel}</button>
          </div>
          <Popover.Arrow className="confirm-arrow" width={12} height={6} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
