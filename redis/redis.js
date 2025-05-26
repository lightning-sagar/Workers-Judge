import { createClient } from 'redis';

const connectredis = async()=>{
    const client = createClient({
        username: 'default',
        password: process.env.password_redis,
        socket: {
            host: process.env.host_redis,
            port: 19417
        }
    });

    client.on('error', err => console.log('Redis Client Error', err));

    await client.connect()
        .then(() => {
            console.log("connected with redis");
        })
        .catch((err)=>{
            console.log({err:'error while connecting'})
        })

    return client;
}

export {connectredis};