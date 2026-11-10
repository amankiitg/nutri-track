/**
 * Sending the trial code through Resend's HTTP API.
 *
 * A thin client over a single endpoint. Resend has no send path here for anything but
 * the trial code; account emails go through Supabase's own SMTP integration, which is
 * configured separately in supabase/config.toml. The API key is never logged or
 * returned; a failure is reported as a status and the message stays generic.
 */
export interface ResendEmail {
  to: string;
  subject: string;
  text: string;
}

export interface EmailClient {
  send(email: ResendEmail): Promise<void>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const RESEND_URL = "https://api.resend.com/emails";
const FROM = "NutriTrack <no-reply@tracknutri.app>";

export function createResendClient(apiKey: string, fetchImpl: FetchLike = fetch): EmailClient {
  return {
    async send(email) {
      let response: Response;
      try {
        response = await fetchImpl(RESEND_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + apiKey,
          },
          body: JSON.stringify({
            from: FROM,
            to: [email.to],
            subject: email.subject,
            text: email.text,
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new Error("Could not reach the email service.");
      }

      if (!response.ok) {
        throw new Error("The email service refused the message.");
      }
    },
  };
}
