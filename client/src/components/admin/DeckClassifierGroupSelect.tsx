import { useMemo, useState } from 'react';
import { SelectMenu, TextInput } from '@/components/common';

export function DeckClassifierGroupSelect({
  value,
  groups,
  onChange,
}: {
  value: string;
  groups: readonly string[];
  onChange: (value: string) => void;
}) {
  const options = useMemo(
    () =>
      [...new Set(groups.map((group) => group.trim()).filter(Boolean))].sort((left, right) =>
        left.localeCompare(right, 'zh-CN')
      ),
    [groups]
  );
  const [mode, setMode] = useState({ value, custom: false });
  // A form reset or external selection should reset only this input's transient mode.
  if (mode.value !== value) setMode({ value, custom: false });
  const custom =
    (mode.value === value && mode.custom) || Boolean(value && !options.includes(value.trim()));
  return (
    <div className="space-y-2">
      <SelectMenu
        label="所属系列／分组"
        value={custom ? 'custom' : value ? `group:${value.trim()}` : 'empty'}
        options={[
          { value: 'empty', label: '请选择系列／分组', disabled: true },
          ...options.map((group) => ({ value: `group:${group}`, label: group })),
          { value: 'custom', label: '自定义…' },
        ]}
        className="w-full"
        onChange={(selected) => {
          const next = selected === 'custom' ? '' : selected.slice(6);
          setMode({ value: next, custom: selected === 'custom' });
          onChange(next);
        }}
      />
      {custom ? (
        <TextInput
          aria-label="自定义系列／分组"
          value={value}
          maxLength={80}
          required
          placeholder="输入新的系列／分组"
          onChange={(event) => {
            const next = event.target.value;
            setMode({ value: next, custom: true });
            onChange(next);
          }}
        />
      ) : null}
    </div>
  );
}
