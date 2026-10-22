import { createAuthClient } from "better-auth/react";
import { emailOTPClient, magicLinkClient, usernameClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [magicLinkClient(), emailOTPClient(), usernameClient()],
});
