import { expect, test } from "@playwright/test";

test("registration gates the cockpit and confirmed mock meetings update the UI", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("registration-form")).toBeVisible();
  await expect(page.getByTestId("cockpit")).toHaveCount(0);
  await page.getByTestId("register-name").fill("Demo Visitor");
  await page.getByTestId("register-company").fill("Example Motors");
  await page.getByTestId("register-email").fill("demo@example.test");
  await page.getByTestId("register-scenario").fill("Evaluate a multilingual vehicle assistant");
  await page.getByTestId("register-privacy").check();
  await expect(page.getByTestId("register-marketing")).not.toBeChecked();
  await page.getByTestId("register-submit").click();
  await expect(page.getByTestId("cockpit")).toBeVisible();
  await page.getByRole("button", { name: "Work IQ", exact: true }).click();
  await page.getByRole("button", { name: "Create simulated meeting +" }).click();
  await page.getByRole("textbox", { name: "Title *", exact: true }).fill("Browser acceptance meeting");
  await page.locator('input[name="startsAt"]').fill("2030-10-03T10:00");
  await page.getByRole("textbox", { name: "Location *", exact: true }).fill("Demo studio");
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your confirmation is needed" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Browser acceptance meeting", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Browser acceptance meeting", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Browser acceptance meeting", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Insights", exact: true }).click();
  const diagnostics = page.locator("section").filter({ has: page.getByRole("heading", { name: "Conversation diagnostics", exact: true }) }).last();
  await expect(diagnostics.getByText("work.createMeeting", { exact: false })).toBeVisible();
  await expect(diagnostics).not.toContainText("Browser acceptance meeting");
  const downloadReady = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export diagnostics", exact: true }).click();
  const download = await downloadReady;
  expect(download.suggestedFilename()).toBe("car-demo-diagnostics.json");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const exported = Buffer.concat(chunks).toString("utf8");
  expect(JSON.parse(exported).tools.count).toBeGreaterThan(0);
  expect(exported).not.toContain("demo@example.test");
  expect(exported).not.toContain("Browser acceptance meeting");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Media", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open Spotify", exact: true })).toHaveAttribute("href", /^https:\/\/open\.spotify\.com/);
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Tap to talk", exact: true })).toBeDisabled();
});

test("the five language choices are available before registration", async ({ page }) => {
  await page.goto("/");
  const select = page.getByTestId("locale-select");
  await expect(select).toBeVisible();
  for (const locale of ["en-US", "zh-CN", "ja-JP", "ko-KR", "de-DE"]) {
    await select.selectOption(locale);
    await expect(select).toHaveValue(locale);
    await expect(page.getByTestId("registration-form")).toBeVisible();
  }
});

test("the admin route is localized and denies access without Entra configuration", async ({ page }) => {
  await page.goto("/#/admin");
  await expect(page.getByRole("heading", { name: "Administrator", exact: true })).toBeVisible();
  await expect(page.getByText("Administrator access is unavailable.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with Microsoft", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("registration-form")).toHaveCount(0);
  const select = page.getByRole("combobox", { name: "Language", exact: true });
  await select.selectOption("zh-CN");
  await expect(page.getByRole("heading", { name: "管理后台", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("link", { name: "返回演示", exact: true }).click();
  await expect(page.getByTestId("registration-form")).toBeVisible();
});

test("non-Realtime model selection cannot inherit the Realtime WebRTC transport", async ({ page }) => {
  await page.route("**/api/capabilities", async route => {
    const response = await route.fetch();
    const capability = await response.json();
    capability.voiceTransports.webrtc.status = "ready";
    await route.fulfill({ response, json: capability });
  });
  await page.goto("/");
  await page.getByTestId("register-name").fill("Transport Visitor");
  await page.getByTestId("register-company").fill("Example Motors");
  await page.getByTestId("register-email").fill("transport@example.test");
  await page.getByTestId("register-scenario").fill("Validate distinct model transports");
  await page.getByTestId("register-privacy").check();
  await page.getByTestId("register-submit").click();
  const models = page.locator("select").filter({ has: page.locator('option[value="gpt-live-1"]') });
  const transports = page.locator("select").filter({ has: page.locator('option[value="websocket"]') });
  await expect(transports).toHaveValue("webrtc");
  for (const model of ["gpt-live-1", "gpt-6.1-sol"]) {
    await models.selectOption(model);
    await expect(transports).toHaveValue("websocket");
    await expect(transports.locator('option[value="webrtc"]')).toHaveJSProperty("disabled", true);
    await expect(page.getByRole("button", { name: "Tap to talk", exact: true })).toBeDisabled();
  }
});

test("the API protects demo data and confirms stateful mock operations", async ({ request }) => {
  const base = "http://127.0.0.1:3001";
  const anonymous = await request.get(`${base}/api/demo`);
  expect(anonymous.status()).toBe(401);

  const registration = await request.post(`${base}/api/register`, {
    data: {
      name: "Integration Visitor", company: "Example Motors", email: "integration@example.test",
      scenario: "Test simulated meetings", privacyConsent: true, marketingConsent: false, locale: "en-US"
    }
  });
  expect(registration.ok()).toBe(true);
  const session = await registration.json();
  const headers = { Authorization: `Bearer ${session.token}` };
  const action = {
    callId: crypto.randomUUID(),
    name: "work.createMeeting",
    args: {
      title: "E2E simulated meeting",
      startsAt: "2030-10-01T08:00:00.000Z",
      durationMinutes: 30,
      attendees: ["alex@example.test"],
      location: "Demo studio",
      notes: "Fictional test meeting"
    }
  };
  const proposed = await request.post(`${base}/api/actions`, { headers, data: action });
  expect(proposed.ok()).toBe(true);
  const pending = await proposed.json();
  expect(pending.status).toBe("confirmation-required");
  const confirmed = { ...action, confirmationId: pending.confirmationId, confirm: true };
  const execution = await request.post(`${base}/api/actions`, { headers, data: confirmed });
  expect(execution.ok()).toBe(true);
  const result = await execution.json();
  expect(result.status).toBe("completed");
  expect(result.provider).toBe("mock");
  const repeated = await request.post(`${base}/api/actions`, { headers, data: confirmed });
  expect((await repeated.json()).status).toBe("completed");
  const current = await request.get(`${base}/api/demo`, { headers });
  const state = await current.json();
  expect(state.meetings.filter((meeting: { title: string }) => meeting.title === action.args.title)).toHaveLength(1);

  const mail = {
    callId: crypto.randomUUID(), name: "work.sendMail",
    args: { to: "alex@example.test", subject: "Cancelled draft", body: "This simulated message must not be sent." }
  };
  const mailProposal = await request.post(`${base}/api/actions`, { headers, data: mail });
  const mailPending = await mailProposal.json();
  expect(mailPending.status).toBe("confirmation-required");
  const cancellation = await request.post(`${base}/api/actions`, {
    headers, data: { ...mail, confirmationId: mailPending.confirmationId, confirm: false }
  });
  expect((await cancellation.json()).status).toBe("cancelled");
  const afterCancel = await (await request.get(`${base}/api/demo`, { headers })).json();
  expect(afterCancel.mail.some((message: { subject: string }) => message.subject === mail.args.subject)).toBe(false);
});
