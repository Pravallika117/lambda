This is an AWS lambda fucntion to the react-ui application.

This runs in Node js version 18.x. The contents of this repository needs to be zipped and uploaded in the AWS lambda console(code section). 

The lambda is called through API gateway(another service of AWS) which is integrated with the UI application running on S3 as a static application. The API gateway is authorized by Cognito user pool.

