import clsx from 'clsx'

export function Logo({
  className,
  ...props
}: React.ComponentPropsWithoutRef<'span'>) {
  return (
    <span
      className={clsx(
        'flex items-center text-base font-semibold text-zinc-900 dark:text-white',
        className,
      )}
      {...props}
    >
      Rockware Docs
    </span>
  )
}
