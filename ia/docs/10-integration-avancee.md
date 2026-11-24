# Intégration Avancée

## Intégration dans une application web

### JavaScript / TypeScript

```typescript
class ConvessaClient {
  private apiKey: string;
  private baseUrl = 'https://convessa.epac-uac-optica-chapter.bj/api/v1';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async sendMessage(recipient: string, message: string): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/send`, {
      method: 'POST',
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient, message }),
    });
    const data = await response.json();
    return data.success === true;
  }

  async sendImage(recipient: string, imageUrl: string, caption?: string): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/send`, {
      method: 'POST',
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient,
        message: caption,
        media: { type: 'image', url: imageUrl },
      }),
    });
    const data = await response.json();
    return data.success === true;
  }
}

// Utilisation
const convessa = new ConvessaClient('pk_convessa_votre_cle');
await convessa.sendMessage('22960000000', 'Votre commande est prête !');
```

### Python

```python
import requests

class ConvessaClient:
    BASE_URL = 'https://convessa.epac-uac-optica-chapter.bj/api/v1'

    def __init__(self, api_key: str):
        self.api_key = api_key
        self.headers = {
            'X-API-Key': api_key,
            'Content-Type': 'application/json'
        }

    def send_message(self, recipient: str, message: str) -> dict:
        response = requests.post(
            f'{self.BASE_URL}/send',
            headers=self.headers,
            json={'recipient': recipient, 'message': message}
        )
        return response.json()

    def send_document(self, recipient: str, doc_url: str, filename: str) -> dict:
        response = requests.post(
            f'{self.BASE_URL}/send',
            headers=self.headers,
            json={
                'recipient': recipient,
                'media': {
                    'type': 'document',
                    'url': doc_url,
                    'mimetype': 'application/pdf',
                    'filename': filename
                }
            }
        )
        return response.json()

# Utilisation
client = ConvessaClient('pk_convessa_votre_cle')
result = client.send_message('22960000000', 'Bonjour depuis Python !')
print(result)
```

### PHP

```php
<?php
class ConvessaClient {
    private string $apiKey;
    private string $baseUrl = 'https://convessa.epac-uac-optica-chapter.bj/api/v1';

    public function __construct(string $apiKey) {
        $this->apiKey = $apiKey;
    }

    public function sendMessage(string $recipient, string $message): array {
        $ch = curl_init("{$this->baseUrl}/send");
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => [
                "X-API-Key: {$this->apiKey}",
                'Content-Type: application/json',
            ],
            CURLOPT_POSTFIELDS => json_encode([
                'recipient' => $recipient,
                'message' => $message,
            ]),
        ]);
        $response = curl_exec($ch);
        curl_close($ch);
        return json_decode($response, true);
    }
}

// Utilisation
$convessa = new ConvessaClient('pk_convessa_votre_cle');
$result = $convessa->sendMessage('22960000000', 'Message depuis PHP !');
var_dump($result);
```

## Envoi en masse (bulk)

Pour envoyer à une liste de contacts, envoyez les requêtes en séquence avec un délai. CONVESSA gère déjà la file d'attente, mais il est conseillé de ne pas envoyer plus de 1000 requêtes en une seule rafale.

```python
import time
import requests

contacts = ['22960000001', '22960000002', '22960000003']
api_key = 'pk_convessa_votre_cle'

for contact in contacts:
    response = requests.post(
        'https://convessa.epac-uac-optica-chapter.bj/api/v1/send',
        headers={'X-API-Key': api_key},
        json={
            'recipient': contact,
            'message': f'Bonjour ! Votre réservation est confirmée.'
        }
    )
    print(f"{contact}: {response.json()}")
    time.sleep(0.5)  # Délai entre les requêtes (CONVESSA ajoute aussi son propre délai)
```

## Notifications automatiques avec Webhook

Configurez un webhook pour être notifié du statut de chaque message :

1. Créez un endpoint sur votre serveur qui accepte les requêtes POST
2. Configurez l'URL dans le tableau de bord CONVESSA
3. CONVESSA enverra un POST à chaque changement de statut

```python
# Exemple Flask (Python)
from flask import Flask, request, jsonify

app = Flask(__name__)

@app.route('/webhook/convessa', methods=['POST'])
def webhook():
    data = request.json
    event = data.get('event')
    message_id = data.get('messageId')
    status = data.get('status')

    print(f"Message {message_id}: {status}")

    if status == 'failed':
        # Gérer l'échec...
        pass

    return jsonify({'received': True})
```

## Cas d'usage courants

### Confirmation de commande e-commerce

Envoyez automatiquement une confirmation WhatsApp après chaque achat :

```python
def on_order_created(order):
    client.send_message(
        order.phone,
        f"Commande #{order.id} confirmée ! "
        f"Montant : {order.total} FCFA. "
        f"Livraison prévue le {order.delivery_date}."
    )
```

### Rappel de rendez-vous

Envoyez un rappel 24h avant chaque rendez-vous :

```python
def send_appointment_reminder(appointment):
    client.send_message(
        appointment.patient_phone,
        f"Rappel : Votre rendez-vous est demain {appointment.time} "
        f"avec Dr {appointment.doctor}. Répondez OUI pour confirmer."
    )
```

### Alerte de stock bas

```python
def on_low_stock(product, quantity):
    client.send_message(
        ADMIN_PHONE,
        f"Alerte stock : {product.name} — seulement {quantity} unités restantes !"
    )
```
