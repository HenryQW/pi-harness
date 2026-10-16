# Pi Bark

Pi Bark sends Pi responses and status notifications to a Bark App installation.

## Language

**Bark App**:
The iOS app that receives and displays push notifications.

**Bark server**:
The service that accepts push requests and forwards notifications through Apple Push Notification service.

**Device Key**:
The secret that identifies the Bark App installation that receives a push notification. It permits sending, not decryption.

**Push request**:
A request to a Bark server that contains a Device Key and push content.

**Push notification**:
The message delivered through Apple Push Notification service and displayed by the Bark App.

**Body**:
The main push content displayed in a push notification.

**Status notification**:
A push that reports that Pi needs input, finished, or failed. It includes the session name, but no prompt, agent output, or error text.

**Session name**:
The current Pi conversation display name used in status notifications, independent of Herdr state.

**Notification default**:
The automatic-notification setting inherited by working directories without a CWD override.

**CWD override**:
An automatic-notification setting for one absolute working directory. It does not affect an explicit response push.

**Server URL**:
The base address of the Bark server selected to receive push requests.

**Push Encryption**:
Optional protection of push content from the Bark server and Apple Push Notification service. It does not protect the Device Key.

**Custom Encryption Key**:
The secret shared with the Bark App to encrypt and decrypt push content, separate from the Device Key.

**Algorithm**:
The encryption algorithm and key size selected in the Bark App.

**Mode**:
The block cipher mode selected in the Bark App.

**Padding**:
The padding rule selected in the Bark App.

**Ciphertext**:
The encrypted push content sent to the Bark server.

**GCM authentication tag**:
The integrity value appended to GCM-encrypted content before Base64 encoding.

**IV**:
The per-push initialization vector sent with Ciphertext for Bark decryption.
_Avoid_: nonce
