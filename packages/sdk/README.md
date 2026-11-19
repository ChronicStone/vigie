# @vigiejs/sdk

Typed definitions for [Vigie](https://vigie.chronicstone.dev): everything in your app's `definitions/` folder imports from here.

```sh
npm i -D @vigiejs/sdk
```

```ts
// definitions/alerts/shop.ts
import { defineAlert } from '@vigiejs/sdk'

export const checkoutErrors = defineAlert({
  id: 'checkout-errors',
  name: 'Checkout failing',
  family: 'Requests',
  when: { source: 'request-error-rate' },
  above: 2,
  window: '10m',
  unit: '%',
})
```

Vigie resolves this import itself when it loads your definitions, so the package is only needed for types in your editor and CI. Every definition is documented at [vigie.chronicstone.dev/docs/definitions](https://vigie.chronicstone.dev/docs/definitions/overview).

## License

MIT
