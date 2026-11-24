import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import {
  type ButtonHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  useOptimistic,
  useTransition,
} from 'react';
import { useFormStatus } from 'react-dom';

export const buttonVariants = cva('codophon-button', {
  defaultVariants: {
    size: 'default',
    variant: 'default',
  },
  variants: {
    size: {
      default: 'codophon-button-size-default',
      icon: 'codophon-button-size-icon',
      lg: 'codophon-button-size-lg',
      sm: 'codophon-button-size-sm',
    },
    variant: {
      default: 'codophon-button-default',
      destructive: 'codophon-button-destructive',
      ghost: 'codophon-button-ghost',
      link: 'codophon-button-link',
      outline: 'codophon-button-outline',
      secondary: 'codophon-button-secondary',
    },
  },
});

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    action?: () => Promise<unknown> | unknown;
    asChild?: boolean;
    pendingPlaceholder?: ReactNode;
  };

export function Button({
  action,
  asChild = false,
  children,
  className,
  disabled,
  onClick: initialOnClick,
  pendingPlaceholder = '…',
  size,
  type,
  variant,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : 'button';
  const [optimisticIsPending, setOptimisticIsPending] = useOptimistic(false);
  const [transitionIsPending, startTransition] = useTransition();
  const { pending: formIsPending } = useFormStatus();

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    initialOnClick?.(event);

    if (!action || event.defaultPrevented) {
      return;
    }

    event.preventDefault();
    startTransition(async () => {
      setOptimisticIsPending(true);
      await action();
    });
  };

  const isPending = transitionIsPending || optimisticIsPending || formIsPending;

  return (
    <Component
      aria-busy={isPending || undefined}
      className={buttonVariants({ className, size, variant })}
      disabled={disabled || isPending || undefined}
      onClick={initialOnClick || action ? onClick : undefined}
      type={type}
      {...props}
    >
      {isPending ? pendingPlaceholder : children}
    </Component>
  );
}
