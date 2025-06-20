// index.js (Your Lambda function file for DynamoDB)

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require('uuid'); // To generate unique IDs for new items
const { PollyClient, SynthesizeSpeechCommand } = require("@aws-sdk/client-polly");
const { S3Client } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");

// DynamoDB client and document client setup
const client = new DynamoDBClient({}); // Use empty object for default config (region, credentials from runtime)
const docClient = DynamoDBDocumentClient.from(client);// Initialize Polly Client with default configuration (region, credentials from runtime)
const pollyClient = new PollyClient({});

// DynamoDB table name
// Changed from environment variable to hardcoded "products" as requested.
const TABLE_NAME = "products";

/**
 * Helper function to create a standardized response object.
 * @param {number} statusCode
 * @param {object | string} body
 * @returns {object}
 */
const formatResponse = (statusCode, body) => {
    return {
        statusCode: statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*', // IMPORTANT: For CORS
            'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'
        },
        body: JSON.stringify(body)
    };
};
const getUserEmailFromToken = (headers) => {
    const authorizationHeader = headers && (headers.Authorization || headers.authorization); // Case-insensitive check

    if (!authorizationHeader) {
        console.warn("Authorization header missing.");
        return null;
    }

    // Extract the token (remove "Bearer ")
    const token = authorizationHeader.startsWith('Bearer ') ? authorizationHeader.substring(7) : authorizationHeader;

    try {
        // JWTs have three parts separated by dots: Header.Payload.Signature
        const parts = token.split('.');
        if (parts.length !== 3) {
            console.error("Invalid JWT format: Not 3 parts.");
            return null;
        }

        // Decode the payload (second part) from Base64Url
        const decodedPayload = Buffer.from(parts[1], 'base64').toString('utf8');
        const payload = JSON.parse(decodedPayload);

        // Common claims for email in Cognito ID tokens are 'email' or 'cognito:username'
        return payload.email || payload['cognito:username'] || payload.preferred_username || null;

    } catch (e) {
        console.error("Error decoding JWT or parsing payload:", e);
        return null;
    }
}

exports.handler = async (event) => {
    try {
        const httpMethod = event.httpMethod;
        const pathParameters = event.pathParameters || {};
        const queryParams = event.queryStringParameters || {};
        const body = event.body ? JSON.parse(event.body) : {};

        // --- GET (Read) Operations ---
        if (httpMethod === 'GET') {
            let user = getUserEmailFromToken(event.headers);
            let searchTerm = queryParams.search;
            let items = [];

            try {
                // Check if 'user' query parameter is present in the event
                
                console.log(`Filtering products for user: ${user}`);

                let exclusiveStartKey = undefined;
                do {
                    const params = {
                        TableName: TABLE_NAME,
                        FilterExpression: "userId = :u", // DynamoDB attribute name for the user ID
                        ExpressionAttributeValues: {
                            ":u": user
                        },
                        ExclusiveStartKey: exclusiveStartKey
                    };
                    // If a search term is provided, add FilterExpression
                    if (searchTerm) {
                        params.FilterExpression += " AND contains(searchname, :s)";
                        params.ExpressionAttributeValues = {
                            ...params.ExpressionAttributeValues,
                            ":s": searchTerm // DynamoDB 'contains' is case-sensitive by default.
                                            // For case-insensitive search, you'd need to store a lowercased version of productname
                                            // or perform client-side filtering after fetching all, but that defeats backend search purpose.
                                            // For now, it's case-sensitive.
                        };
                        console.log(`Performing scan with search term: "${searchTerm}"`);
                    } else {
                        console.log("Fetching all products (no search term).");
                    }
                    const command = new ScanCommand(params);
                    const response = await docClient.send(command);

                    if (response.Items) {
                        items.push(...response.Items);
                    }
                    exclusiveStartKey = response.LastEvaluatedKey;
                } while (exclusiveStartKey);

                return {
                    statusCode: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*' // CORS header for web apps
                    },
                    body: JSON.stringify(items)
                };

            } catch (error) {
                console.error(`Error: ${error}`);
                return {
                    statusCode: 500,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    body: JSON.stringify({ message: `Failed to retrieve products: ${error.message}` })
                };
            }
        }

        // --- POST (Create) Operation ---
        else if (httpMethod === 'POST') {
            const productname = body.productname;
            const user = body.user;
            const quantity = parseInt(body.quantity, 10);
            const price = parseFloat(body.price);

            if (!productname || isNaN(quantity) || isNaN(price)) {
                return formatResponse(400, { message: 'Missing productname, quantity, or price in request body' });
            }

            const newItem = {
                productid: uuidv4(), // Generate a unique ID for the new item, assigned to 'productid'
                productname: productname,
                quantity: quantity,
                price: price,
                userId: user,
                searchname: productname.toLowerCase(),
                createdAt: new Date().toISOString() // Optional: add a timestamp
            };

            const command = new PutCommand({
                TableName: TABLE_NAME,
                Item: newItem
            });
            await docClient.send(command);

             const input = {
                OutputFormat: 'mp3', // Audio format
                Text: productname,
                VoiceId: 'Joanna',
                // Optional: TextType: 'ssml' if your text contains SSML markup
            };
            console.log('input',JSON.stringify(input));
            // Create a SynthesizeSpeechCommand
            const pollycommand = new SynthesizeSpeechCommand(input);

            // Send the command and get the response
            const {AudioStream} = await pollyClient.send(pollycommand);


            const audioKey = `${newItem.productid}.mp3`;

            // Store the audio file in S3.
            const s3Client = new S3Client();
            const upload = new Upload({
                    client: s3Client,
                    params: {
                    Bucket: 'ecom-polly-audio',
                    Key: audioKey,
                    Body: AudioStream,
                    ContentType: "audio/mp3",
                },
            });
            await upload.done();   

            return formatResponse(201, newItem); // Return the newly created item
        }

        // --- PUT (Update) Operation ---
        else if (httpMethod === 'PUT') {
            const productId = pathParameters.id; // Still comes from path parameter 'id'
            const productname = body.productname;
            const quantity = parseInt(body.quantity, 10);
            const price = parseFloat(body.price);

            if (!productId || !productname || isNaN(quantity) || isNaN(price)) {
                return formatResponse(400, { message: 'Missing product ID, productname, quantity, or price in request' });
            }

            const command = new UpdateCommand({
                TableName: TABLE_NAME,
                Key: { productid: productId }, // Using 'productid' as the primary key for update
                UpdateExpression: "set #pn = :pn, #q = :q, #p = :p, #sn = :sn", // Update productname, quantity, price
                ExpressionAttributeNames: {
                    "#pn": "productname",
                    "#q": "quantity",
                    "#p": "price",
                    "#sn": "searchname"
                },
                ExpressionAttributeValues: {
                    ":pn": productname,
                    ":q": quantity,
                    ":p": price,
                    ":sn": productname.toLowerCase()
                },
                ReturnValues: "ALL_NEW" // Return the updated item
            });

            const { Attributes } = await docClient.send(command);

            if (!Attributes) {
                // This case might mean the item didn't exist, DynamoDB UpdateCommand creates if not exists by default.
                // To strictly check if item existed, you might need a ConditionalExpression or a preceding GetCommand.
                // For simplicity, we assume successful update implies item was present or created.
                return formatResponse(404, { message: 'Item not found for update (or issue updating)' });
            }
            const input = {
                OutputFormat: 'mp3', // Audio format
                Text: productname,
                VoiceId: 'Joanna',
                // Optional: TextType: 'ssml' if your text contains SSML markup
            };
            console.log('input',JSON.stringify(input));
            // Create a SynthesizeSpeechCommand
            const pollycommand = new SynthesizeSpeechCommand(input);

            // Send the command and get the response
            const {AudioStream} = await pollyClient.send(pollycommand);


            const audioKey = `${productId}.mp3`;

            // Store the audio file in S3.
            const s3Client = new S3Client();
            const upload = new Upload({
                    client: s3Client,
                    params: {
                    Bucket: 'ecom-polly-audio',
                    Key: audioKey,
                    Body: AudioStream,
                    ContentType: "audio/mp3",
                },
            });
            await upload.done();  

            return formatResponse(200, Attributes); // Return the updated item
        }

        // --- DELETE Operation ---
        else if (httpMethod === 'DELETE') {
            // Changed from itemId to productId to reflect new primary key
            const productId = pathParameters.id;
            if (!productId) {
                return formatResponse(400, { message: 'Missing product ID in path' });
            }

            const command = new DeleteCommand({
                TableName: TABLE_NAME,
                Key: { productid: productId }, // Using 'productid' as the primary key for delete
                ReturnValues: "ALL_OLD" // To check if an item was actually deleted
            });
            const { Attributes } = await docClient.send(command);

            if (!Attributes) {
                return formatResponse(404, { message: 'Item not found for deletion' });
            }

            // For DELETE, typically return 204 No Content
            return {
                statusCode: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'
                }
            };
        }

        // --- OPTIONS (CORS Preflight) ---
        else if (httpMethod === 'OPTIONS') {
            return formatResponse(200, {}); // Empty body for OPTIONS
        }

        // --- Unsupported HTTP Method ---
        else {
            return formatResponse(405, { message: 'Method Not Allowed' });
        }

    } catch (error) {
        console.error("Error:", error);
        return formatResponse(500, { message: `Internal Server Error: ${error.message}` });
    }
};
