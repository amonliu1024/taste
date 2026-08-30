import { useState, type ReactNode } from "react";
import * as Select from "@radix-ui/react-select";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "./Icons";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectMenuProps {
  ariaLabel: string;
  placeholder: string;
  options: SelectOption[];
  onSelect: (value: string) => void | Promise<void>;
  disabled?: boolean;
  compact?: boolean;
  expandable?: boolean;
  collapsedIcon?: ReactNode;
}

/** Shared action select with keyboard navigation, viewport bounds and consistent styling. */
export default function SelectMenu({ ariaLabel, placeholder, options, onSelect, disabled = false, compact = false, expandable = false, collapsedIcon }: SelectMenuProps) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);

  function choose(next: string) {
    setValue(next);
    void Promise.resolve(onSelect(next)).finally(() => setValue(""));
  }

  return (
    <Select.Root value={value} open={open} onOpenChange={setOpen} onValueChange={choose} disabled={disabled || options.length === 0}>
      <Select.Trigger className={`select-trigger ${compact ? "is-compact" : ""} ${expandable ? "is-expandable" : ""}`} aria-label={ariaLabel}>
        {expandable && !open ? <span className="select-collapsed-icon">{collapsedIcon}</span> : <><Select.Value placeholder={placeholder} /><Select.Icon className="select-trigger-icon"><ChevronDownIcon /></Select.Icon></>}
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-content" position="popper" align="start" sideOffset={4} collisionPadding={8}>
          <Select.ScrollUpButton className="select-scroll"><ChevronUpIcon /></Select.ScrollUpButton>
          <Select.Viewport className="select-viewport">
            {options.map((option) => (
              <Select.Item className="select-item" key={option.value} value={option.value}>
                <Select.ItemText><span className="select-item-label" title={option.label}>{option.label}</span></Select.ItemText>
                <Select.ItemIndicator className="select-item-check"><CheckIcon /></Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className="select-scroll"><ChevronDownIcon /></Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
