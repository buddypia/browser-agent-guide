# Privacy Policy for Browser Agent Guide

Last updated: 2026-06-18

This Privacy Policy explains how Browser Agent Guide (the "Extension") handles user information and data.

## 1. No Server-Side Data Collection
Browser Agent Guide is designed with privacy as a fundamental priority. We do **not** collect, store, or transmit any personal data, browsing history, or user credentials to any server owned by the developer or any third party, other than the AI API providers explicitly configured by you. All operations and settings are processed locally on your device.

## 2. What Data We Access and How It Is Used
To perform its core functions as an AI-assisted page controller and annotation guide, the Extension accesses the following types of information:

*   **Active Tab URL and Content:** The Extension retrieves the URL and text content of the active tab in order to query your configured AI API and auto-apply your saved visual notes or automation rules on that page/domain.
*   **User-configured API Keys:** The Extension requires an API key for your chosen AI provider (OpenAI, Anthropic, Gemini, or custom OpenAI-compatible endpoint) to function.
*   **Prompt History and Page-Scoped Chat History:** The Extension stores past chat messages to provide context for conversational threads and allow quick prompt reuse.
*   **User Drawings and Notes:** Any visual annotations (circles, boxes, arrows, freehand lines) and notes you create are stored on your device.
*   **Webpage Screenshots:** If you trigger the "Draw to image" capture feature to composite your visual drawings onto the page screenshot, a temporary screenshot is captured and processed on your device.

## 3. How Data Is Stored
All settings, API keys, prompt histories, page memory rules, and annotations are stored locally on your device using:
*   `chrome.storage.local` (local extension storage)

No data is synced unless you export it manually. We do not use `chrome.storage.sync` to ensure your API keys and sensitive histories never leave your device.

## 4. Third-Party Services
The Extension interacts with the third-party AI service provider that you configure in the Settings page (OpenAI, Anthropic, Gemini, or a custom OpenAI-compatible API endpoint).
*   **Data Sent:** When you send a prompt or capture context, the prompt, page description, and page feedback drawings are sent directly to the configured AI API endpoint.
*   **Direct Connection:** The Extension makes direct HTTPS requests from your browser to the chosen AI provider's API. No intermediate proxy servers are used.
*   **Privacy Policies:** Please refer to the privacy policies of your chosen AI provider (e.g., OpenAI, Anthropic, or Google Gemini) to understand how they handle data submitted via their APIs.

## 5. Data Sharing
We do **not** sell, trade, or share any user data with third parties.

## 6. Data Retention and Deletion
All data is stored locally in your browser's extension profile. You have complete control over this data:
*   **Clear Chat History:** You can clear the current page's chat history at any time using the "Clear Chat" button in the side panel.
*   **Remove Memory Rules:** You can view, edit, or delete any saved annotations, custom styles, or automation rules in the Settings panel.
*   **Uninstall:** Uninstalling the Extension from Chrome will automatically delete all local storage, settings, and saved data associated with the Extension.

## 7. Compliance and Certifications
In accordance with the Chrome Web Store Developer Agreement, we certify that:
*   We do not sell user data.
*   We do not use or transfer user data for purposes unrelated to the Extension's core functionality.
*   We do not use or transfer user data to determine creditworthiness or for lending purposes.

## 8. Changes to This Policy
We may update this Privacy Policy from time to time. Any changes will be posted on this page, and the "Last updated" date will be updated accordingly.

## 9. Contact
If you have any questions or feedback regarding this Privacy Policy, please contact the developer via:
*   GitHub Repository Issues: [https://github.com/buddypia/browser-agent-guide/issues](https://github.com/buddypia/browser-agent-guide/issues)
