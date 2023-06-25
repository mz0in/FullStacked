# Integration Tests

Integration tests are a bit tricky because we need to run them inside the docker compose network to access our other services and we need to do that while gathering the coverage data.

Here's a bit of how it is setup :

![FullStacked Integration Test Setup](https://files.cplepage.com/fullstacked/integration-test.png)

To run integration tests, use the `utils/testIntegration` wrapper method to make your test run inside docker.

## Example

```ts
import testIntegration from "fullstacked/utils/testIntegration";
import {after, before, describe, it} from "mocha";
import Server from "fullstacked/server";
import {equal} from "assert";
import {fetch} from "fullstacked/utils/fetch";

// import your server file to test
import "../server/index.ts";

// wrap your test suite with FullStacked integration test utility
testIntegration(describe("Integration Test", () => {
    before(() => {
        // start the server
        Server.start()
    });

    it("Should hit /hello-world endpoint", async () => {
        // hit an endpoint
        equal(await fetch.get("http://localhost/hello-world"), "Hello World");
    });

    after(() => {
        // make sure to stop the server or it will hang
        Server.stop();
    });
}));
```

## Coverage

This will cover your Server code.