import { Toast } from "@base-ui/react/toast";

export const toastManager = Toast.createToastManager();

export function toast(text: string) {
  toastManager.add({ description: text, timeout: 2600 });
}

function List() {
  const { toasts } = Toast.useToastManager();
  return (
    <>
      {toasts.map((item) => (
        <Toast.Root key={item.id} toast={item} className="toast">
          <Toast.Description>{item.description}</Toast.Description>
        </Toast.Root>
      ))}
    </>
  );
}

export function Toaster({ children }: { children: React.ReactNode }) {
  return (
    <Toast.Provider toastManager={toastManager}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="toastv">
          <List />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
